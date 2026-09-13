/**
 * 登录状态判定回归：node deploy/test-storage-auth.js
 */
const assert = require("assert");
const {
  storageStateLooksLoggedIn,
  getMaoyanCookies,
  getIdentityCookies,
  loginFingerprint,
  isIdentityCookie,
} = require("../lib/storage-auth");

function testEmptyState() {
  assert.strictEqual(storageStateLooksLoggedIn({ cookies: [], origins: [] }), false);
}

function testTrackingOnlyCookies() {
  const state = {
    cookies: [
      { name: "_lxsdk_cuid", value: "abc", domain: ".maoyan.com" },
      { name: "_lxsdk", value: "def", domain: ".maoyan.com" },
      { name: "Hm_lvt", value: "1", domain: ".maoyan.com" },
      { name: "csrf", value: "x", domain: ".maoyan.com" },
      { name: "uuid", value: "y", domain: ".maoyan.com" },
      { name: "mygsig", value: "z", domain: ".maoyan.com" },
    ],
    origins: [],
  };
  assert.strictEqual(storageStateLooksLoggedIn(state), false);
  assert.strictEqual(getIdentityCookies(state).length, 0);
}

function testAuthCookie() {
  const state = {
    cookies: [{ name: "passport_token", value: "x", domain: ".maoyan.com" }],
    origins: [],
  };
  assert.strictEqual(storageStateLooksLoggedIn(state), true);
}

function testManySessionCookiesWithoutIdentity() {
  const cookies = Array.from({ length: 8 }, (_, i) => ({
    name: `k${i}`,
    value: `v${i}`,
    domain: ".maoyan.com",
  }));
  assert.strictEqual(storageStateLooksLoggedIn({ cookies, origins: [] }), false);
}

function testIdentityCookieFilter() {
  assert.strictEqual(isIdentityCookie("csrf"), false);
  assert.strictEqual(isIdentityCookie("uuid"), false);
  assert.strictEqual(isIdentityCookie("mygsig"), false);
  assert.strictEqual(isIdentityCookie("passport_token"), true);
}

function testLoginFingerprintIgnoresTracking() {
  const base = {
    cookies: [
      { name: "passport_token", value: "a", domain: ".maoyan.com" },
      { name: "_lxsdk", value: "b", domain: ".maoyan.com" },
    ],
  };
  const changedTracking = {
    cookies: [
      { name: "passport_token", value: "a", domain: ".maoyan.com" },
      { name: "_lxsdk", value: "c", domain: ".maoyan.com" },
    ],
  };
  assert.strictEqual(loginFingerprint(base), loginFingerprint(changedTracking));
}

function testMaoyanDomainFilter() {
  const cookies = getMaoyanCookies({
    cookies: [
      { name: "passport_token", value: "x", domain: ".google.com" },
      { name: "passport_token", value: "y", domain: ".maoyan.com" },
    ],
  });
  assert.strictEqual(cookies.length, 1);
}

testEmptyState();
testTrackingOnlyCookies();
testAuthCookie();
testManySessionCookiesWithoutIdentity();
testIdentityCookieFilter();
testLoginFingerprintIgnoresTracking();
testMaoyanDomainFilter();
console.log("ALL PASSED (storage auth)");
