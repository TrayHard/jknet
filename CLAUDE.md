# Проект: лаунчер JKNet

JKNet — десктопный лаунчер мультиплеера Star Wars Jedi Knight на Tauri 2: ядро на Rust, фронтенд на React, TypeScript и Tailwind CSS v4. Работают все пять экранов: **Home**, **Clients**, **Library**, **Servers** и **Friends** — установка движка, запуск игры, файлы pk3 клиента, браузер серверов, вход в JKNet Online и друзья.

## Язык

- Отвечайте пользователю по-русски и применяйте скилл `dev-docs-style-ru`.
- Документацию репозитория (`README.md`, `CLAUDE.md`, `docs/*.md`) пишите по-русски.
- Код, идентификаторы и комментарии в коде пишите по-английски.
- Тексты интерфейса пишите по-английски и складывайте в `src/locales/en/`: английский — исходный язык лаунчера. Компонент со строкой внутри валит `npm run i18n:check`. Правила — в [документе о локализации](docs/i18n.md).

## Команды

Запускайте из корня репозитория, если не указано иное.

| Задача | Команда |
| --- | --- |
| Установить зависимости | `npm install` |
| Запустить приложение | `npm run tauri dev` |
| Собрать фронтенд с проверкой типов | `npm run build` |
| Проверить только типы | `npm run typecheck` |
| Проверить переводы и экраны | `npm run i18n:check` |
| Разложить новые ключи по языкам | `npm run i18n:seed` |
| Скомпилировать ядро | `cargo check --all-targets` в `src-tauri` |
| Проверить линтером | `cargo clippy --all-targets -- -D warnings` в `src-tauri` |
| Прогнать тесты ядра | `cargo test` в `src-tauri` |
| Собрать установщик | `npm run tauri build` |
| Поднять заглушку JKNet Online | `node scripts/mock-online.mjs` |
| Переписать снимок категорий JKHub | `powershell -ExecutionPolicy Bypass -File scripts/refresh-jkhub-categories.ps1` |

Не запускайте `npm run tauri dev` из агента без прямой просьбы: команда открывает окно и не завершается.

Скрипт `refresh-jkhub-categories.ps1` обходит jkhub.org и переписывает `src-tauri/resources/jkhub/categories-*.json` — дерево категорий, вшитое в сборку. Запускайте его перед выпуском и коммитьте оба файла. Обход стоит около сорока запросов к чужому сайту, поэтому в цикле его не запускают. Ключ `-DryRun` печатает команду и пути, ничего не меняя. Подробности — в разделе [«JKHub» документа об архитектуре](docs/architecture.md#jkhub).

## Структура

```
src/
  index.css              подключение Tailwind, блок @theme, базовые стили
  styles/tokens.css      токены дизайна из Figma
  styles/fonts.css       локальные шрифты @fontsource и дисплейный шрифт
                         для кириллических языков
  i18n/                  перевод: настройка i18next, список языков, типы
                         ключей, перевод ошибок ядра, форматирование через
                         Intl, синхронизация с настройкой языка
  locales/<язык>/        каталоги строк: 14 пространств имён на язык.
                         en — исходный язык, в нём же _notes.md для
                         переводчиков
  components/            AppShell, TitleBar, Sidebar, GameSwitch, PageHeader,
                         NewClientDialog, ClientSettingsDialog,
                         GameFilesNotice, MissingClientToast,
                         GameEventsProvider, AppUpdateProvider, AboutCard,
                         MapPreview, MapPicturesCard, ToastsProvider,
                         FriendsProvider, AccountProvider
  components/ui/         UI-кит: Button, Badge, Input, Select, Toggle, NavItem,
                         EmptyState, RadioCard, StepBadges, Toast, Avatar, Dialog
  components/library/    экран Library: карточка, диалоги, категории,
                         вкладка JKHub: JkhubBrowser, JkhubCard, JkhubDetails,
                         JkhubTree
  components/servers/    экран Servers: таблица, панель сведений, фильтры, Tabs
  components/account/    учётная запись: карточка Settings, кнопки провайдеров,
                         ожидание браузера
  components/friends/    экран Friends: строка, панель друга, заявки, presence.ts
  pages/                 по одному файлу на маршрут
  pages/onboarding/      три шага первого запуска и защита маршрутов
  lib/ipc.ts             типизированные обёртки над invoke
  lib/queries.ts         хуки React Query и ключи запросов
  lib/game.ts            активная игра: имена, клиенты игры, клиент по
                         умолчанию, игра по порту сервера
  lib/useGameEvents.ts   подписка на события установки движка и запуска игры
  lib/useAppUpdate.ts    проверка, загрузка и установка обновления лаунчера
  lib/runtime.ts         isTauri: проверка, что страница живёт в окне Tauri
  lib/format.ts          cn, shortenPath и чистые функции форматирования,
                         которым передают локаль
  lib/devOnline.ts       подмена команд друзей вызовами к заглушке JKNet
                         Online вне Tauri
src-tauri/
  src/lib.rs             сборка приложения, плагины, список команд
  src/state.rs           общее состояние: config_root и настройки
  src/paths.rs           раскладка папок данных, перенос из старой папки
  src/settings.rs        settings.json
  src/game.rs            две игры и таблица их констант
  src/game_files.rs      поиск GameData обеих игр в Steam и GOG
  src/engines.rs         статический реестр движков обеих игр
  src/engine_install.rs  релизы GitHub, загрузка и распаковка архива движка
  src/clients.rs         клиенты на диске
  src/servers/           браузер серверов: мастер-серверы, ping, кеш
  src/launch.rs          запуск клиента, корень basepath\ у Jedi Outcast,
                         слежение за процессом, остановка
  src/library.rs         файлы pk3 одного клиента в его папке home\
  src/levelshots.rs      картинки карт из архивов игрока и кеш к ним
  src/online/            клиент JKNet Online: типы контракта, запросы, ошибки
  src/jkhub/             каталог jkhub.org: клиент с ограничителем, кеш,
                         снимок дерева категорий в сборке, разборщики страниц,
                         скачивание и установка в клиента
  resources/jkhub/       categories-ja.json и categories-jo.json: дерево
                         категорий, с которого вкладка рисуется до обхода
  src/account.rs         вход через браузер и команды учётной записи
  src/friends/           друзья, присутствие, приглашения и живой сокет
  capabilities/          разрешения окна main
scripts/
  mock-online.mjs        заглушка JKNet Online на Node без зависимостей
  i18n-check.mjs         сверка каталогов и поиск строк в компонентах
  i18n-seed.mjs          разложение новых ключей по папкам языков
  i18n-allowlist.json    слова, которые компонент печатает без t()
  make-brand-assets.ps1  растровые копии знака из public/jknet_logo.png
  refresh-jkhub-categories.ps1
                         обход jkhub.org и перезапись снимка категорий
public/
  jknet_logo.png         мастер-файл знака, 846 px
  brand/                 копии знака 64, 128, 256 и 512 px для интерфейса
```

## Модель сущностей

- **Движок** — сборка клиента игры: OpenJK, EternalJK, TaystJK, jaMME.
- **Клиент** — именованный экземпляр движка со своим набором файлов и настроек. Один движок обслуживает сколько угодно клиентов.
- **Файл библиотеки** — pk3 со скином, рукояткой, картой или модом. Устанавливается в выбранный клиент.
- **Игра** — атрибут движка, клиента и строки сервера, а не сущность. Игр две: Jedi Academy (`ja`) и Jedi Outcast (`jo`). Все различия между ними лежат в таблице `GameSpec` в `src-tauri/src/game.rs`; больше нигде игры не зашиты. Активную игру задаёт переключатель в боковой панели, а на фронтенде её обслуживает `src/lib/game.ts`.

Понятия «профиль» в JKNet нет. Не вводите его ни в коде, ни в интерфейсе.

## Токены и утилиты Tailwind

Токены приходят из Figma через `jknet-tokens.json`. Имя переменной Figma `color/bg/app` даёт свойство `--color-bg-app`.

Файл `src/styles/tokens.css` содержит примитивы, семантические цвета, шкалу `--space-*`, размеры `--size-*` и свечения. Блок `@theme` в `src/index.css` содержит то, чьи имена Tailwind занимает под себя: `--spacing`, `--radius-*`, `--font-*`, `--shadow-*`. Объявлять их в обоих файлах нельзя: получится циклическая ссылка.

Блок `@theme` также обнуляет палитру Tailwind (`--color-*: initial`) и заводит 40 коротких псевдонимов цвета. Девять самых частых:

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
- Настройки меняйте патчем: отправляйте в `update_settings` только изменённые поля. Документ из кеша React Query целиком не отправляйте, иначе запись затрёт поля, изменённые другим писателем.
- Долгую операцию защищайте от повторного запуска в ядре, а не только выключенной кнопкой: множество занятых `clientId` в состоянии Tauri, как `InstallState` в `engine_install.rs`.
- Вызов Tauri из фронтенда закрывайте проверкой `isTauri` из `lib/runtime.ts`. Команда `npm run dev` открывает тот же код в браузере, где `window.__TAURI_INTERNALS__` нет и любой вызов бросает `TypeError`.
- Ошибки возвращайте вариантом `AppError` из `src-tauri/src/error.rs`. Строку в `Err` не пишите: вариант делает журнал доступным для поиска.
- Разрешения в `src-tauri/capabilities/default.json` добавляйте по одному, только под то, что действительно вызываете.
- Выпадающий список берите из UI-кита: `Select` в `src/components/ui/Select.tsx`. Нативный `<select>` не применяйте: его попап рисует система, а не страница, и WebView2 красит его белым поверх светлого текста. Правило `color-scheme: dark` в `src/index.css` — только страховка на случай нативного контрола, который всё-таки появится.
- Маршрутизация работает на `HashRouter`. Ссылки вида `#/servers` переживают перезагрузку окна, обычные пути — нет.
- Логи пишет `tauri-plugin-log` в `logs\` внутри папки данных. Туда же попадают `console.warn` и `console.error` фронтенда: их пересылает `src/main.tsx`.
- Данные лаунчера лежат в `%LOCALAPPDATA%\org.jknet.launcher`, папке идентификатора пакета. Путь приходит из `app.path().app_local_data_dir()` в обработчике `setup`. Не пишите в `%LOCALAPPDATA%\JKNet`: туда установщик NSIS ставит саму программу, а деинсталлятор чистит папку идентификатора.

## Чего не делать

- Не переименовывайте токены и не задавайте цвета числами: макет и код разойдутся.
- Не добавляйте библиотеку компонентов. UI-кит в `src/components/ui` пишем сами.
- Не пишите в папку игры. Лаунчер читает только архивы `base\assets*.pk3` своей игры.
- Не удаляйте `clients\<slug>\basepath\base` рекурсивно и не распаковывайте в эту папку. Это соединение каталогов на `base` игрока: снимайте его вызовом `std::fs::remove_dir`. Правила задаёт функция `prepare_basepath` в `src-tauri/src/launch.rs`, объясняет раздел [«Соединение каталогов на папку игры»](docs/architecture.md#соединение-каталогов-на-папку-игры).
- Не зашивайте константу игры в модуль. Всё, что различается между Jedi Academy и Jedi Outcast, берите из `GameSpec`.
- Не выполняйте `git commit` и `git push` без прямой просьбы пользователя.
- Не заводите «профили»: сущности три — движок, клиент, файл библиотеки.

## Документация

- [README.md](README.md) — что это, как запустить и собрать.
- [docs/architecture.md](docs/architecture.md) — модули ядра, раскладка на диске, таблица команд IPC, список заглушек.
- Дизайн: `docs/jknet-design.md` в родительской рабочей папке `D:\Dev\Personal\jedi academy`.
