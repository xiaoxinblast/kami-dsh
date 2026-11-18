// Only the isolated smoke process loads this guard; release discovery and npm installation do not.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

function denied(channel) {
  if (process.env.DSH_KERNEL_NETWORK_LOG) appendFileSync(process.env.DSH_KERNEL_NETWORK_LOG, JSON.stringify({ channel, blocked: true, pid: process.pid }) + "\n");
  throw new Error("OFFLINE_SMOKE: all network requests are denied");
}
globalThis.fetch = () => denied("fetch");
for (const client of [http, https]) for (const method of ["request", "get"]) client[method] = () => denied(method);
for (const method of ["connect", "createConnection"]) net[method] = () => denied(`net.${method}`);
net.Socket.prototype.connect = () => denied("socket.connect");
tls.connect = () => denied("tls.connect");
syncBuiltinESMExports();
