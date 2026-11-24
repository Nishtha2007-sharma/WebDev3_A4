# Bestie Chat backend

This is an enhanced, separate backend copy. The originally uploaded `server(1).js` is not modified.

## Start
```bash
npm install
npm start
```
Then open `http://localhost:8080`.

The server stores users and messages in `backend/data/chat-data.json` (created automatically). Passwords are salted and hashed with Node's built-in `crypto.scrypt`. Auth sessions are in memory, so users must log in again after restarting the server.

This is a deadline demo build: use only local/demo accounts. It has no production-grade rate limiting, email verification, password reset, HTTPS deployment setup, or multi-process database. Do not expose it publicly with real personal data.
