# MFVPN SOCKS5 backend

This is a Node.js VPS-side SOCKS5 server for the MFVPN Minecraft client. It has no npm dependencies, requires username/password authentication and refuses to start if either credential is missing.

## Deploy with Docker Compose

1. Copy `backend/.env.example` to `backend/.env` and set a unique username and a long random password.
2. On the VPS, install Docker Engine and the Docker Compose plugin.
3. Copy this `backend` directory to the VPS, then run `docker compose up -d --build` from it. The image is based on Node.js 22 and runs as an unprivileged user.
4. Allow TCP port 1080 in the VPS firewall only from your own public IP where possible.
5. In MFVPN's settings, enable SOCKS5 and enter the VPS address, port, username and password.

Set `MFVPN_PORT` in `.env` if you want a different public port. The Node process binds inside the container to port 1080. Use `docker compose logs -f` to inspect startup and `docker compose down` to stop it.

## Run directly with Node.js

Install Node.js 20 or newer, set `MFVPN_USER`, `MFVPN_PASSWORD`, and optionally `MFVPN_HOST` / `MFVPN_PORT`, then run `npm start` from this directory. No `npm install` step is needed.

## Security

SOCKS5 username/password authentication does not encrypt traffic between Minecraft and the VPS. Use this on a trusted network or place it behind an encrypted tunnel (for example WireGuard); keep the firewall restricted and never expose an unauthenticated proxy. This backend currently supports TCP CONNECT only.
