const crypto = require("crypto");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";
const SIGN_SECRET = "A013F70DB97834C0A5492378BD76C53A";

function generateSignKey(method = "GET", ua = USER_AGENT, channelId = 40009, indexOverride) {
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
      (t, e) => (params[e] === 0 || params[e] ? `${t}&${e}=${params[e]}` : `${t}&${e}=''`),
      "",
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

function buildWuKongQuery(movieId, extra = {}) {
  const sk = generateSignKey("GET", USER_AGENT);
  const q = {
    movieId: String(movieId || "").trim(),
    WuKongReady: "h5",
    timeStamp: String(sk.timeStamp),
    "User-Agent": sk.encodedUA,
    index: String(sk.index),
    channelId: String(sk.channelId),
    sVersion: "2",
    signKey: sk.signKey,
    ...extra,
  };
  return new URLSearchParams(
    Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])),
  ).toString();
}

function buildLoginWarmApiUrls(movieId) {
  const mid = String(movieId || "").trim();
  return [
    `/i/api/movie/getBoxShow?movieId=${mid}&boxLevel=1&yodaReady=h5&csecplatform=4&csecversion=4.3.0`,
    `/i/api/movie/getPredictionBox?${buildWuKongQuery(mid)}`,
    `/i/api/movie/getTechData?${buildWuKongQuery(mid)}`,
    `/i/api/movie/getBoxShowna?${buildWuKongQuery(mid)}`,
    `/i/api/movie/getWantData?${buildWuKongQuery(mid, { token: "" })}`,
  ];
}

module.exports = {
  USER_AGENT,
  generateSignKey,
  buildWuKongQuery,
  buildLoginWarmApiUrls,
};
