import assert from "node:assert/strict";
import { test } from "node:test";
import { GameStateApiError, GameStateClient } from "../sdk/client.js";

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("explicit root base URL keeps API routes at the root", async () => {
  const calls = [];
  const client = new GameStateClient({ baseUrl: "/", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, { user: { id: "u1" } });
  } });

  await client.me();

  assert.equal(calls[0].url, "/me");
});

test("fetch implementation is invoked with the global receiver", async () => {
  let receiver;
  const fetchImpl = function () {
    receiver = this;
    return Promise.resolve(jsonResponse(200, { user: { id: "u1" } }));
  };
  const client = new GameStateClient({ fetchImpl });

  await client.me();

  assert.equal(receiver, globalThis);
});

test("register and login send credentials and install returned bearer token", async () => {
  const calls = [];
  const client = new GameStateClient({ baseUrl: "/api/game-state/", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(url.endsWith("register") ? 201 : 200, {
      token: url.endsWith("register") ? "registered-token" : "login-token",
      expiresAt: "2030-01-01T00:00:00Z",
      user: { id: "u1", login: "player", displayName: "Player" },
    });
  } });

  const registration = await client.register({ login: "player", password: "secret", displayName: "Player" });
  assert.equal(registration.token, "registered-token");
  assert.equal(client.token, "registered-token");
  assert.equal(calls[0].url, "/api/game-state/auth/register");
  assert.deepEqual(JSON.parse(calls[0].options.body), { login: "player", password: "secret", displayName: "Player" });
  assert.equal(calls[0].options.headers.Authorization, undefined);

  await client.me();
  assert.equal(calls[1].options.headers.Authorization, "Bearer registered-token");

  await client.login({ login: "player", password: "secret" });
  assert.equal(calls[2].url, "/api/game-state/auth/login");
  assert.equal(client.token, "login-token");
});

test("logout sends bearer token and clears it", async () => {
  let request;
  const client = new GameStateClient({ fetchImpl: async (url, options) => {
    request = { url, options };
    return jsonResponse(200, { ok: true });
  } });
  client.setToken("session-token");

  await client.logout();

  assert.equal(request.url, "/api/game-state/auth/logout");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer session-token");
  assert.equal(client.token, null);
});

test("state routes encode path identifiers and preserve structured 409 errors", async () => {
  const calls = [];
  const client = new GameStateClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(409, { error: { code: "VERSION_CONFLICT", message: "State changed" } });
  } });
  client.setToken("token");

  await assert.rejects(
    client.saveState("my game", "zone/one", { data: { count: 2 }, score: 2, version: 4 }),
    (error) => error instanceof GameStateApiError
      && error.status === 409
      && error.code === "VERSION_CONFLICT"
      && error.message === "State changed",
  );
  assert.equal(calls[0].url, "/api/game-state/apps/my%20game/zones/zone%2Fone/state");
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(calls[0].options.headers.Authorization, "Bearer token");
  assert.deepEqual(JSON.parse(calls[0].options.body), { data: { count: 2 }, score: 2, version: 4 });
});
