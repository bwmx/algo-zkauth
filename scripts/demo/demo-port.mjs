// Fails fast when something already listens on the demo's port, before the
// quickstart spends minutes on downloads and builds only for the server to hit
// EADDRINUSE. "localhost" resolves to both 127.0.0.1 and ::1, so a listener on
// either one would make a browser reach a different server than this demo.
//
//   node scripts/demo/demo-port.mjs
import { connect } from "node:net";

export const DEMO_PORT = 8765;

const listening = (host, port) => new Promise(resolve => {
  const socket = connect({ host, port });
  const done = result => { socket.destroy(); resolve(result); };
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
  socket.setTimeout(1000, () => done(false));
});

export async function busyHosts(port = DEMO_PORT, hosts = ["127.0.0.1", "::1"]) {
  const results = await Promise.all(hosts.map(host => listening(host, port)));
  return hosts.filter((_, i) => results[i]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const busy = await busyHosts();
  if (busy.length) {
    console.error(`Port ${DEMO_PORT} is already in use on ${busy.join(" and ")}. Stop the other server first:
  - the service stack's web app:   docker compose --profile local stop web
  - the demo in Docker:            docker compose --profile quickstart down
  - an earlier demo started here:  lsof -nP -iTCP:${DEMO_PORT} -sTCP:LISTEN  (then kill its PID)`);
    process.exit(1);
  }
}
