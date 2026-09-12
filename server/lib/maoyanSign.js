import crypto from "crypto";
import { USER_AGENT } from "./config.js";

const SIGN_SECRET = "A013F70DB97834C0A5492378BD76C53A";
const MYG_SALT = "581409236#";

export function generateSignKey(method, ua = USER_AGENT, channelId = 40009, indexOverride) {
  const timeStamp = Date.now();
  const encodedUA = Buffer.from(ua).toString("base64");
  const index =
    indexOverride !== undefined && indexOverride !== null && Number.isFinite(Number(indexOverride))
      ? Number(indexOverride)
      : Math.floor(Math.random() * 1000 + 1);
  const params = {
    method,
    timeStamp,
    "User-Agent": encodedUA,
    index,
    channelId,
    sVersion: 2,
    key: SIGN_SECRET,
  };
  const d = Object.keys(params)
    .reduce(
      (t, e) =>
        params[e] === 0 || params[e] ? `${t}&${e}=${params[e]}` : `${t}&${e}=''`,
      ""
    )
    .slice(1)
    .replace(/\s+/g, " ");
  return {
    signKey: crypto.createHash("md5").update(d).digest("hex"),
    timeStamp,
    encodedUA,
    index,
    channelId,
  };
}

export function buildMygsig(params, m3 = "0.0.67") {
  const entries = Object.keys(params).map((k) => [k, params[k]]);
  entries.sort((a, b) => {
    const ka = a[0].toLowerCase();
    const kb = b[0].toLowerCase();
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const qbStr = entries.map((e) => String(e[1])).join("_");
  const ts = Date.now();
  const ms1 = crypto.createHash("md5").update(`${MYG_SALT}${qbStr}$${ts}`).digest("hex");
  return JSON.stringify({ m1: "0.0.3", m2: 0, m3, ms1, ts, ts1: ts - 50 });
}

export function generateUid() {
  return crypto
    .createHash("sha1")
    .update(`maoyan_${Date.now()}_${Math.random()}`)
    .digest("hex");
}

export function randomUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
