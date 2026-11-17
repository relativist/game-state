# Интеграция REST Game State API

Сервис предоставляет только JSON API: регистрация, вход, сохранение прогресса и рейтинги. Полный контракт, ограничения и форматы ошибок описаны в [README](../README.md).

## Адрес и клиент

На rich базовый URL — `http://rich:4173/api/game-state` (либо IP rich). Локальный Docker Compose — `http://localhost:3005`, без префикса. Отдельных HTML-страниц и статических маршрутов у сервиса нет.

Можно использовать обычный fetch или необязательный модуль `sdk/client.js` из репозитория. Скопируйте модуль в проект своей игры и импортируйте с адреса игры:

```js
import { GameStateClient, GameStateApiError } from "./client.js";
const gameState = new GameStateClient({ baseUrl: "/api/game-state" });
// Для локального API на другом порту: baseUrl: "http://localhost:3005"
// В этом случае в CORS_ORIGINS API укажите origin страницы игры.
```

При необходимости можно задать другой `baseUrl` или собственную реализацию `fetch`:

```js
const gameState = new GameStateClient({ baseUrl: "/api/game-state" });
```

Методы возвращают промисы с JSON-телом ответа. Для защищённых маршрутов клиент добавляет `Authorization: Bearer <token>`, если токен установлен.

## Учётная запись и токен

Регистрация создаёт учётную запись и устанавливает полученный токен в экземпляр клиента. Вход также устанавливает токен:

```js
// Регистрация сразу открывает сеанс:
const { token, expiresAt, user } = await gameState.register({
  login: "player1", password: "secret", displayName: "Игрок",
});

// Для уже существующего аккаунта используйте вместо регистрации:
// const { token, expiresAt, user } = await gameState.login({ login: "player1", password: "secret" });
```

`displayName` при регистрации необязателен. В результате входа `user` содержит `id`, `login` и `displayName`.

По умолчанию токен хранится только в памяти экземпляра клиента. Если приложению нужно восстановить сеанс после перезагрузки страницы, сохраните токен явно и восстановите его через `setToken`:

```js
sessionStorage.setItem("game-token", token);
// При создании следующего экземпляра:
gameState.setToken(sessionStorage.getItem("game-token"));
const { user } = await gameState.me();
```

`sessionStorage` в этом примере — решение вызывающего приложения, не автоматическое хранилище клиента. Выбирайте хранение токена с учётом модели угроз вашего приложения. Вызов `logout()` отправляет запрос на сервер и очищает токен клиента даже при ошибке запроса; приложение должно также удалить собственную копию токена.

## Состояние и контроль версий

Состояния принадлежат вошедшему пользователю. Идентификаторы приложения и зоны передаются отдельными сегментами URL и автоматически кодируются клиентом.

```js
const { states } = await gameState.listStates("my-game");

try {
  const { state } = await gameState.getState("my-game", "level-1");
  console.log(state.data, state.score, state.version, state.updatedAt);
} catch (error) {
  if (error instanceof GameStateApiError && error.status === 404) {
    // Сохранения в этой зоне пока нет
  } else {
    throw error;
  }
}

const { state } = await gameState.saveState("my-game", "level-1", {
  data: { unlocked: [1, 2], position: { x: 10, y: 4 } },
  score: 1250, // необязательно; неотрицательное безопасное целое число
  version: 0,  // для нового сохранения; иначе передайте прочитанную версию
});
```

`data` должен быть JSON-объектом. `version` обязателен и должен быть целым числом. Для первого сохранения используется `0`; при изменении существующего состояния передавайте его текущую версию. Успешный `PUT` возвращает новое состояние с новой версией.

Ответ `409 Conflict` означает, что состояние успело измениться после чтения. Клиент выбрасывает `GameStateApiError` с полями `status` и серверным `code`; сообщение доступно через `message`. Не повторяйте запись вслепую с новой версией: загрузите актуальное состояние, объедините изменения по правилам игры и попросите пользователя разрешить конфликт, если объединение неоднозначно.

## Таблица лидеров и место игрока

Таблица лидеров доступна без токена. Запрос принимает `limit` (по умолчанию 10):

```js
const { players, limit } = await gameState.leaderboard("my-game", "level-1", { limit: 10 });
// players: [{ userId, displayName, score, rank }]
```

Для своего места требуется авторизация:

```js
const { rank, score } = await gameState.rank("my-game", "level-1");
// rank и score могут быть null, если игрок ещё не представлен в зоне
```

## Маршруты API

Все URL ниже указаны с публичным префиксом `/api/game-state`.

| Метод и путь | Авторизация | Назначение и тело |
|---|---|---|
| `POST /auth/register` | Нет | `{ login, password, displayName? }` |
| `POST /auth/login` | Нет | `{ login, password }`; ответ `{ token, expiresAt, user }` |
| `POST /auth/logout` | Bearer | Завершить текущий сеанс |
| `GET /me` | Bearer | Текущий пользователь: `{ user }` |
| `GET /apps/:app/states` | Bearer | Список сохранений: `{ states }` |
| `GET /apps/:app/zones/:zone/state` | Bearer | Состояние `{ state }` или `404`, если его нет |
| `PUT /apps/:app/zones/:zone/state` | Bearer | `{ data, score?, version }`; ответ `{ state }`, конфликт версии — `409` |
| `GET /apps/:app/zones/:zone/leaderboard?limit=10` | Нет | `{ players, limit }` |
| `GET /apps/:app/zones/:zone/rank` | Bearer | `{ rank, score }`, значения могут быть `null` |

Тело ошибки имеет вид `{ "error": { "code": "...", "message": "..." } }`. `GameStateApiError.status` содержит HTTP-статус, `GameStateApiError.code` — машинный код сервера (если передан), `message` — сообщение. Для `409` проверяйте статус либо код, а `404` состояния можно трактовать как отсутствие сохранения.

## Обычный fetch без SDK

```js
const base = "/api/game-state";
const response = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ login: "player1", password: "secret" }),
});
const session = await response.json();
if (!response.ok) throw new Error(session.error.message);
const token = session.token;

const saved = await fetch(`${base}/apps/math/zones/default/state`, {
  method: "PUT",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    version: 0, // только первое сохранение; далее версия из GET или PUT
    score: 10,
    data: { schemaVersion: 1, exercise: 12, passed: [1, 2], draft: {} },
  }),
});
const result = await saved.json();
if (!saved.ok) throw new Error(result.error.message);
// result.state.version использовать при следующем сохранении.
```

Для продолжения на другом устройстве сначала выполните вход, затем GET того же состояния. При 404 начните с version:0; при успешном GET используйте state.data и state.version. При 409 перечитайте запись и разрешите конфликт, прежде чем сохранять повторно.
