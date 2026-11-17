# Game State

Общий REST backend для HTML-игр: независимые пользователи, сохранения между устройствами, публичные рейтинги по картам. Node.js 24 + PostgreSQL 18. Существующие аккаунты Chess Quest / Foxy Chat не используются.

## Быстрый запуск

```sh
cp .env.example .env
# Заменить GAME_STATE_POSTGRES_PASSWORD в .env случайным паролем.
docker compose -f compose.yml up -d --build
```

API: http://localhost:3005. Проверка доступности: http://localhost:3005/health. Сервис предоставляет только JSON API.
База `game-state` создаётся в отдельном PostgreSQL с persistent volume; таблицы при старте создаются в транзакции под advisory lock. Внешнего порта БД в Compose нет.

Без Docker: `npm ci`, создать базу и задать `DATABASE_URL`, затем `npm start`. Node автоматически не читает `.env`: можно использовать `node --env-file=.env src/server.js`. Для localhost-разработки игра должна отдаваться HTTP-сервером; для другого origin прописать `CORS_ORIGINS` (через запятую).

## API

Внутри сервиса пути начинаются с `/`, на rich базовый URL `/api/game-state/`. Формат запроса/ответа JSON, кроме статических файлов; заголовок запросов с телом — `Content-Type: application/json`.

| Метод | Путь | Тело / ответ |
|---|---|---|
| POST | `/auth/register` | `{login,password,displayName?}` → `{token,expiresAt,user}` (201) |
| POST | `/auth/login` | `{login,password}` → `{token,expiresAt,user}` |
| POST | `/auth/logout` | Отзыв текущего токена → `{ok:true}` |
| GET | `/me` | `{user:{id,login,displayName}}` |
| GET | `/apps/:app/states` | `{states:[state,...]}` — свои сохранения всех карт |
| GET | `/apps/:app/zones/:zone/state` | `{state}` либо 404 |
| PUT | `/apps/:app/zones/:zone/state` | `{data:{...},score?,version}` → `{state}` |
| GET | `/apps/:app/zones/:zone/leaderboard?limit=10` | `{players:[{userId,displayName,score,rank}],limit}` |
| GET | `/apps/:app/zones/:zone/rank` | `{rank,score}` либо оба null |
| GET | `/health` | `{status:"ok"}` при доступной БД |

Вход, регистрация и рейтинг публичны. Остальные операции требуют `Authorization: Bearer <token>`. Пользователь определяется только по токену; userId из тела не используется. Токен живёт 30 дней (SESSION_DAYS, 1–365), сессии устройств независимы; выход отзывает только текущую. Смена/восстановление пароля и управление всеми устройствами пока не реализованы.

`state` содержит `{appId,zoneId,data,score,version,updatedAt}`. Для первой записи передать `version:0`, для последующих — версию прочитанной/последней сохранённой записи. При `409 VERSION_CONFLICT` перечитать данные и предложить игроку выбор/объединение; автоматическая слепая перезапись запрещает смысл защиты от конфликтов.

`app` и `zone`: 1–64 латинских букв/цифр, `_`, `-`, первый символ буква или цифра. Используйте `default` для игры без карт. JSON `data` — объект, целиком заменяемый при сохранении, максимальное тело 256 KiB. Поля состояния и их версии схемы определяет сама игра: например `{schemaVersion:1,exercise:12,passed:[1,2],draft:{...}}`.

`score` — целое от 0 до Number.MAX_SAFE_INTEGER; больше означает лучше. Сохраняется максимум предыдущего и нового результата, прогресс меняется независимо от счёта. Без score рекорд не изменяется; новая запись без score не участвует в рейтинге, 0 участвует. Рейтинг отдельный для каждой карты приложения, `limit` от 1 до 100; при равенстве очков порядок стабилен по userId, места последовательные (1, 2, 3). Общего рейтинга с суммой всех карт пока нет.

Ошибка: `{error:{code,message}}`. Основные HTTP-статусы: 400 валидация, 401 сессия/пароль, 403 origin, 404 нет сохранения/маршрута, 409 занятый логин/конфликт версии, 413 размер тела, 415 тип тела, 429 частые запросы.

Логин регистронезависимый, 3–64 символа `[a-z0-9_.-]`; пароль 4–128 символов. Пароли хешируются scrypt с индивидуальной солью; в БД хранятся SHA-256 хеши случайных 256-битных токенов. Ограничения запросов действуют на процесс: 30 попыток входа/регистрации за 15 минут с IP, всего 600 запросов в минуту с IP. TRUST_PROXY=1 использовать только за доверенным gateway, не публиковать контейнер напрямую. CORS по умолчанию только same-origin, дополнительные origins перечисляются явно; `file://` не поддерживается.

HTML-клиент сам присылает очки, поэтому рейтинг доверяет клиенту. Универсальная проверка результатов без правил конкретной игры невозможна. Не помещайте в публичный HTML серверные секреты.

## Подключение игры

[Описание запросов и примеры подключения](docs/INTEGRATION.md). Необязательный JS-клиент находится в `sdk/client.js`: скопируйте его в проект игры. Сам API статические файлы и HTML не отдаёт.

## Проверка

```sh
npm test
# Создать отдельную тестовую базу с именем game_state_test; не использовать рабочую.
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/game_state_test npm run test:integration
```

Тесты проверяют реальные SQL-запросы и HTTP API, конкурирующие сохранения, изоляцию пользователей и приложений, сессии и рейтинги. Пользователи тестов удаляются по их ID.

## Gateway / rich

Рабочий адрес: `http://192.168.1.6:4173/api/game-state`. Health: `/api/game-state/health`. Развёрнуто 2026-11-17; [результаты проверки](docs/VERIFICATION.md).

Dockerfile приложения находится в этом проекте. В общем `app-docker-container` добавляются сервисы `game-state` и `game-state-postgres`, отдельная внутренняя сеть/volume БД, маршрут `/api/game-state/`. Единственный внешний порт остаётся у gateway.

Скрипт `python3 deploy/integrate-gateway.py /path/to/app-docker-container` дописывает нужные блоки, оставляя существующие настройки. Перед изменениями создаёт резервные копии в `deploy-backups/game-state-<timestamp>`, генерирует пароль только при его отсутствии. Эти копии могут содержать секреты: не публиковать и не коммитить. Повторный запуск не меняет существующий пароль.

Запускать из общего gateway:

```sh
docker compose config --quiet
docker compose up -d --build --no-deps game-state-postgres
docker compose up -d --build game-state
# Только после готовности API:
docker compose exec -T gateway nginx -t
docker compose exec -T gateway nginx -s reload
```

Перед reload проверить health и новую конфигурацию Nginx. Остальные приложения не пересобираются. Если gateway ещё не запущен, сначала запустить его обычным порядком.

Резервное копирование БД: `docker compose exec -T game-state-postgres pg_dump -U game_state -d game-state -Fc > game-state.dump`. Перед восстановлением убедиться в правильном окружении и сохранить текущую БД. Для отката маршрута вернуть из созданной копии только блоки game-state в Compose/Nginx и проверить/reload Nginx; не удалять volume БД. Не накатывать старый полный конфиг поверх последующих изменений других приложений.
