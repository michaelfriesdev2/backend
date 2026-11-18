'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const USER = process.env.MFVPN_USER;
const PASSWORD = process.env.MFVPN_PASSWORD;
const HOST = process.env.MFVPN_HOST || '0.0.0.0';
const PORT = Number(process.env.MFVPN_PORT || 1080);
const AUTH_TIMEOUT_MS = 30_000;
const sockets = new Set();

if (!USER || !PASSWORD) {
  console.error('MFVPN_USER and MFVPN_PASSWORD are required; refusing to start an open proxy.');
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('MFVPN_PORT must be an integer from 1 to 65535.');
  process.exit(1);
}

const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();
const expectedUser = digest(USER);
const expectedPassword = digest(PASSWORD);

function authorized(user, password) {
  return crypto.timingSafeEqual(digest(user), expectedUser)
    && crypto.timingSafeEqual(digest(password), expectedPassword);
}

function reply(socket, status, addressType = 1, address = Buffer.from([0, 0, 0, 0]), port = 0) {
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, status, 0, addressType]), address, portBytes]));
}

function closePair(client, upstream) {
  client.destroy();
  if (upstream) upstream.destroy();
}

function handleClient(client) {
  sockets.add(client);
  client.setTimeout(AUTH_TIMEOUT_MS, () => client.destroy());
  client.on('close', () => {
    sockets.delete(client);
    if (upstream && !upstream.destroyed) upstream.destroy();
  });

  let buffer = Buffer.alloc(0);
  let state = 'greeting';
  let upstream = null;
  let connected = false;

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (!connected) {
      if (state === 'greeting') {
        if (buffer.length < 2) return;
        const version = buffer[0];
        const methodCount = buffer[1];
        if (version !== 5 || buffer.length < 2 + methodCount) return version !== 5 ? client.destroy() : undefined;
        const methods = buffer.subarray(2, 2 + methodCount);
        buffer = buffer.subarray(2 + methodCount);
        if (!methods.includes(2)) {
          client.end(Buffer.from([5, 255]));
          return;
        }
        client.write(Buffer.from([5, 2]));
        state = 'auth';
        continue;
      }

      if (state === 'auth') {
        if (buffer.length < 2) return;
        const userLength = buffer[1];
        if (buffer[0] !== 1) return client.destroy();
        if (buffer.length < 2 + userLength + 1) return;
        const passLengthOffset = 2 + userLength;
        const passLength = buffer[passLengthOffset];
        if (buffer.length < passLengthOffset + 1 + passLength) return;
        const username = buffer.toString('utf8', 2, passLengthOffset);
        const password = buffer.toString('utf8', passLengthOffset + 1, passLengthOffset + 1 + passLength);
        buffer = buffer.subarray(passLengthOffset + 1 + passLength);
        const valid = authorized(username, password);
        client.write(Buffer.from([1, valid ? 0 : 1]));
        if (!valid) return client.end();
        client.setTimeout(0);
        state = 'request';
        continue;
      }

      if (state === 'request') {
        if (buffer.length < 4) return;
        const version = buffer[0];
        const command = buffer[1];
        const addressType = buffer[3];
        if (version !== 5 || buffer[2] !== 0) return client.destroy();

        let addressLength;
        let addressOffset = 4;
        if (addressType === 1) addressLength = 4;
        else if (addressType === 4) addressLength = 16;
        else if (addressType === 3) {
          if (buffer.length < 5) return;
          addressLength = buffer[4];
          addressOffset = 5;
        } else {
          reply(client, 8);
          return client.end();
        }
        const requestLength = addressOffset + addressLength + 2;
        if (buffer.length < requestLength) return;

        const addressBytes = buffer.subarray(addressOffset, addressOffset + addressLength);
        let destination;
        if (addressType === 1) destination = [...addressBytes].join('.');
        else if (addressType === 4) destination = formatIPv6(addressBytes);
        else destination = addressBytes.toString('utf8');
        const destinationPort = buffer.readUInt16BE(addressOffset + addressLength);
        buffer = buffer.subarray(requestLength);

        if (command !== 1) {
          reply(client, 7);
          return client.end();
        }
        if (!destination || destinationPort === 0) {
          reply(client, 1);
          return client.end();
        }

        state = 'connecting';
        upstream = net.createConnection({ host: destination, port: destinationPort });
        upstream.setNoDelay(true);
        upstream.once('connect', () => {
          if (client.destroyed) return upstream.destroy();
          connected = true;
          reply(client, 0);
          client.setNoDelay(true);
          client.pipe(upstream);
          upstream.pipe(client);
          if (buffer.length) upstream.write(buffer);
          buffer = Buffer.alloc(0);
        });
        upstream.once('error', (error) => {
          if (!connected && !client.destroyed) {
            const status = error.code === 'ECONNREFUSED' ? 5 : 4;
            reply(client, status);
            client.end();
          }
          upstream.destroy();
        });
        client.once('error', () => closePair(client, upstream));
        upstream.once('close', () => { if (!client.destroyed) client.end(); });
        return;
      }
      return;
    }
  };

  client.on('data', onData);
  client.on('error', () => { if (upstream) upstream.destroy(); });
}

function formatIPv6(bytes) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(bytes.readUInt16BE(i).toString(16));
  return parts.join(':');
}

const server = net.createServer(handleClient);
server.on('error', (error) => {
  console.error(`SOCKS5 server error: ${error.message}`);
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  console.log(`MFVPN SOCKS5 backend listening on ${HOST}:${PORT} (authentication required)`);
});

function shutdown() {
  server.close();
  for (const socket of sockets) socket.destroy();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
