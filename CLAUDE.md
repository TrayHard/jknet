# Проект: лаунчер JKNet

JKNet — десктопный лаунчер мультиплеера Jedi Academy на Tauri 2: ядро на Rust, фронтенд на React, TypeScript и Tailwind CSS v4. Работают экраны **Home**, **Clients** и **Library**: установка движка, запуск игры и файлы pk3 клиента. Экран **Servers** — заготовка.

## Язык

- Отвечайте пользователю по-русски и применяйте скилл `dev-docs-style-ru`.
- Документацию репозитория (`README.md`, `CLAUDE.md`, `docs/*.md`) пишите по-русски.
- Код, идентификаторы и комментарии в коде пишите по-английски.
- Тексты интерфейса пишите по-английски: сообщество игры международное.

## Команды

Запускайте из корня репозитория, если не указано иное.

| Задача | Команда |
| --- | --- |
| Установить зависимости | `npm install` |
| Запустить приложение | `npm run tauri dev` |
| Собрать фронтенд с проверкой типов | `npm run build` |
| Проверить только типы | `npm run typecheck` |
| Скомпилировать ядро | `cargo check --all-targets` в `src-tauri` |
| Проверить линтером | `cargo clippy --all-targets -- -D warnings` в `src-tauri` |
| Прогнать тесты ядра | `cargo test` в `src-tauri` |
| Собрать установщик | `npm run tauri build` |

Не запускайте `npm run tauri dev` из агента без прямой просьбы: команда открывает окно и не завершается.

## Структура

```
src/
  index.css              подключение Tailwind, блок @theme, базовые стили
  styles/tokens.css      токены дизайна из Figma
  styles/fonts.css       локальные шрифты @fontsource
  components/            AppShell, TitleBar, Sidebar, PageHeader, NewClientDialog,
                         GameEventsProvider
  components/ui/         UI-кит: Button, Badge, Input, Toggle, NavItem, EmptyState
  pages/                 по одному файлу на маршрут
  lib/ipc.ts             типизированные обёртки над invoke
  lib/queries.ts         хуки React Query и ключи запросов
  lib/useGameEvents.ts   подписка на события установки движка и запуска игры
  lib/runtime.ts         isTauri: проверка, что страница живёт в окне Tauri
  lib/format.ts          cn, formatBytes, shortenPath
src-tauri/
  src/lib.rs             сборка приложения, плагины, список команд
  src/state.rs           общее состояние: config_root и настройки
  src/paths.rs           раскладка папок данных
  src/settings.rs        settings.json
  src/game_files.rs      поиск GameData в Steam и GOG
  src/engines.rs         статический реестр движков
  src/engine_install.rs  релизы GitHub, загрузка и распаковка архива движка
  src/clients.rs         клиенты на диске
  src/servers.rs         браузер серверов (заглушка)
  src/launch.rs          запуск клиента, слежение за процессом, остановка
  src/library.rs         файлы pk3 одного клиента в его папке home\
  capabilities/          разрешения окна main
```

## Модель сущностей

- **Движок** — сборка клиента игры: OpenJK, EternalJK, TaystJK, jaMME.
- **Клиент** — именованный экземпляр движка со своим набором файлов и настроек. Один движок обслуживает сколько угодно клиентов.
- **Файл библиотеки** — pk3 со скином, рукояткой, картой или модом. Устанавливается в выбранный клиент.

Понятия «профиль» в JKNet нет. Не вводите его ни в коде, ни в интерфейсе.

## Токены и утилиты Tailwind

Токены приходят из Figma через `jknet-tokens.json`. Имя переменной Figma `color/bg/app` даёт свойство `--color-bg-app`.

Файл `src/styles/tokens.css` содержит примитивы, семантические цвета, шкалу `--space-*`, размеры `--size-*` и свечения. Блок `@theme` в `src/index.css` содержит то, чьи имена Tailwind занимает под себя: `--spacing`, `--radius-*`, `--font-*`, `--shadow-*`. Объявлять их в обоих файлах нельзя: получится циклическая ссылка.

Блок `@theme` также обнуляет палитру Tailwind (`--color-*: initial`) и заводит 39 коротких псевдонимов цвета. Девять самых частых:

| Группа | Токен | Утилита |
| --- | --- | --- |
| фон | `--color-bg-app` | `bg-app` |
| фон | `--color-bg-surface` | `bg-surface` |
| фон | `--color-bg-accent` | `bg-accent` |
| текст | `--color-text-primary` | `text-fg` |
| текст | `--color-text-secondary` | `text-fg-secondary` |
| текст | `--color-text-muted` | `text-fg-muted` |
| текст | `--color-text-accent` | `text-fg-accent` |
| граница | `--color-border-default` | `border-line` |
| граница | `--color-border-focus` | `border-line-focus` |

Полный список псевдонимов — в блоке `@theme`. Правила:

- Пишите цвет только через утилиту-псевдоним или `var(--color-*)`. Утилиты вида `bg-slate-700` не работают: палитра обнулена.
- Отступы измеряются в пикселях: `--spacing: 1px`, поэтому токен `space/16` — это `p-16`, `gap-16`, `mt-16`. Числа вне шкалы допустимы там, где их требует макет: `w-232`, `size-44`.
- Типографику задавайте классами `text-display-xl`, `text-heading-sm`, `text-body-md`, `text-label-xs`, `text-mono-sm` и остальными из `tokens.css`. Класс задаёт шрифт, размер, интерлиньяж и трекинг, но не цвет.
- Иконки берите из `lucide-react` и красьте утилитой текста: иконка рисуется через `currentColor`.

## Соглашения

- Новую команду ядра добавляйте в трёх местах: модуль в `src-tauri/src`, список в `tauri::generate_handler!` в `lib.rs`, обёртка в `src/lib/ipc.ts`. Компоненты вызывают команды только через хуки из `lib/queries.ts`.
- Вызов Tauri из фронтенда закрывайте проверкой `isTauri` из `lib/runtime.ts`. Команда `npm run dev` открывает тот же код в браузере, где `window.__TAURI_INTERNALS__` нет и любой вызов бросает `TypeError`.
- Ошибки возвращайте вариантом `AppError` из `src-tauri/src/error.rs`. Строку в `Err` не пишите: вариант делает журнал доступным для поиска.
- Разрешения в `src-tauri/capabilities/default.json` добавляйте по одному, только под то, что действительно вызываете.
- Маршрутизация работает на `HashRouter`. Ссылки вида `#/servers` переживают перезагрузку окна, обычные пути — нет.
- Логи пишет `tauri-plugin-log` в `logs\` внутри папки данных. Туда же попадают `console.warn` и `console.error` фронтенда: их пересылает `src/main.tsx`.

## Чего не делать

- Не переименовывайте токены и не задавайте цвета числами: макет и код разойдутся.
- Не добавляйте библиотеку компонентов. UI-кит в `src/components/ui` пишем сами.
- Не пишите в папку игры. Лаунчер читает только `base\assets0.pk3`–`assets3.pk3`.
- Не выполняйте `git commit` и `git push` без прямой просьбы пользователя.
- Не заводите «профили»: сущности три — движок, клиент, файл библиотеки.

## Документация

- [README.md](README.md) — что это, как запустить и собрать.
- [docs/architecture.md](docs/architecture.md) — модули ядра, раскладка на диске, таблица команд IPC, список заглушек.
- Дизайн: `docs/jknet-design.md` в родительской рабочей папке `D:\Dev\Personal\jedi academy`.
