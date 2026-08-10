# task-flow

Самостоятельный глобальный Node.js/TypeScript CLI для GitHub/ClickUp workflow.
Пакет не требует файлов, зависимостей или конфигурации в репозиториях
`frontend`, `backend`, `admin` и может запускаться из любой вложенной директории
Git-репозитория.

## Установка

Требования: Node.js 18+, Git и авторизованный
[GitHub CLI (`gh`)](https://cli.github.com/).

```bash
npm install
npm run build
npm link
```

После `npm link` команда доступна глобально:

```bash
task-flow --help
```

Чтобы удалить link, выполните
`npm unlink -g @lilflexer/task-flow-cli`.

## Конфигурация

Создайте глобальный файл `~/.config/task-flow/config.json`:

```json
{
  "defaults": {
    "branch": "master",
    "pullRequestBranches": {
      "master": "master",
      "staging": "staging"
    },
    "branchPrefix": "feat",
    "remote": "origin",
    "pull": true,
    "draft": false,
    "clickup": {
      "branchFieldId": "clickup-branch-custom-field-id",
      "productionPullRequestFieldId": "clickup-production-pr-custom-field-id",
      "stagingPullRequestFieldId": "clickup-staging-pr-custom-field-id",
      "deployFlowFieldName": "Deploy Flow"
    }
  },
  "repositories": {
    "company/frontend": {
      "branch": "master",
      "pullRequestBranches": {
        "master": "master",
        "staging": "staging"
      }
    },
    "company/backend": {
      "pullRequestBranches": {
        "master": "main",
        "staging": "develop"
      },
      "branchPrefix": "feature",
      "clickup": {
        "branchFieldId": "backend-branch-field-id"
      }
    }
  }
}
```

Поддерживаемые свойства слоя `defaults` и каждого repository override:

- `branch` — базовая ветка (`master` по умолчанию);
- `pullRequestBranches.master` — основной target PR; если не задан, используется
  итоговое значение `branch`;
- `pullRequestBranches.staging` — target PR для `Deploy Flow = Staging`;
- `branchPrefix` — префикс рабочей ветки (`feat` по умолчанию);
- `featureBranch` — необязательное полное имя рабочей ветки;
- `remote` — Git remote (`origin` по умолчанию);
- `pull` — выполнять `git pull --ff-only` перед созданием ветки;
- `draft` — создавать draft PR;
- `clickup.apiBaseUrl` — `https://api.clickup.com/api/v2` по умолчанию;
- `clickup.branchFieldId` — ID текстового custom field для веток;
- `clickup.productionPullRequestFieldId` — ID текстового custom field для PR
  в production;
- `clickup.stagingPullRequestFieldId` — ID текстового custom field для PR
  в staging;
- `clickup.deployFlowFieldName` — имя custom field с режимом deploy
  (`Deploy Flow` по умолчанию);
- `clickup.deployFlowFieldId` — необязательный ID поля Deploy Flow; если задан,
  имеет приоритет над поиском по имени;
- `clickup.teamId` — требуется только при использовании custom task IDs.

Итоговое значение выбирается в порядке:

```text
CLI argument
→ repositories["owner/repository"]
→ defaults
→ встроенные значения
```

Токен ClickUp задаётся через окружение:

```bash
export CLICKUP_API_TOKEN=pk_...
```

или через `~/.config/task-flow/.env`:

```dotenv
CLICKUP_API_TOKEN=pk_...
```

Переменная процесса имеет приоритет над `.env`. Рекомендуется ограничить права
на файл: `chmod 600 ~/.config/task-flow/.env`.

## Использование

Создать `feat/86cavbfx9` от `master` и записать ветку в ClickUp:

```bash
cd ~/project/frontend/packages/some-package
task-flow start --branch=master --taskId=86cavbfx9
```

Опубликовать текущую ветку, прочитать `Deploy Flow`, найти существующие или
создать необходимые PR и записать их URL в ClickUp:

```bash
task-flow submit --taskId=86cavbfx9
```

При создании PR его body всегда начинается с названия и URL задачи ClickUp.
Дополнительное описание передаётся через `--description`:

```bash
task-flow submit \
  --taskId=86cavbfx9 \
  --description="Implemented API validation and updated tests"
```

Результат в описании каждого создаваемого PR:

```text
Add some stuff - https://app.clickup.com/t/86cavbfx9

Implemented API validation and updated tests
```

Если `--description` не передан, body содержит только строку с задачей ClickUp.

Все параметры конфигурации можно переопределить в CLI:

```bash
task-flow start \
  --taskId=86cavbfx9 \
  --branch=main \
  --pr-master-branch=main \
  --pr-staging-branch=staging \
  --branch-prefix=fix \
  --no-pull \
  --branch-field-id=custom-field-id

task-flow submit \
  --taskId=86cavbfx9 \
  --description="Implementation details" \
  --pr-master-branch=master \
  --pr-staging-branch=staging \
  --draft \
  --production-pull-request-field-id=production-custom-field-id \
  --staging-pull-request-field-id=staging-custom-field-id \
  --deploy-flow-field-id=deploy-flow-field-id
```

Полный список параметров: `task-flow --help`.

## Deploy Flow и target-ветки PR

Перед `git push` команда `submit` читает custom field `Deploy Flow` из задачи
ClickUp. Поддерживаются два значения:

| Deploy Flow | Создаваемые PR |
| --- | --- |
| `Staging` | сначала `pullRequestBranches.staging`, после merge — promotion в `pullRequestBranches.master` |
| `Production` | только `pullRequestBranches.master` |

Для dropdown-поля CLI преобразует сохранённый ClickUp option ID или
`orderindex` в отображаемое значение `Staging`/`Production`. Текстовые значения
также поддерживаются. Пустое, неизвестное значение или отсутствующая
`pullRequestBranches.staging` для Staging Flow приводят к понятной ошибке до
публикации ветки.

### Promotion после staging

Менять `Deploy Flow` после тестирования не требуется. При повторном `submit`
для `Deploy Flow = Staging` CLI проверяет PR из feature-ветки в настроенную
staging-ветку:

- если PR отсутствует, он создаётся;
- если PR открыт, CLI использует существующий URL и не создаёт дубликат;
- если PR смержен, CLI проверяет, что текущий `HEAD` совпадает с последним
  протестированным commit этого PR;
- если master PR уже открыт или смержен, используется его существующий URL;
- иначе CLI предлагает promotion:

```text
PR to staging_release is already merged.
Press Enter to open PR to master_release or q to cancel:
```

`Enter` создаёт PR в `pullRequestBranches.master`. `q` или `Q` завершает
команду с сообщением `Cancelled` без `git fetch`, `git push` и обновления
ClickUp. Для prompt требуется интерактивный терминал.

Если после merge staging PR в feature-ветке появились новые коммиты, promotion
блокируется: эти изменения должны сначала пройти новый staging PR и
тестирование. Для promotion ветки `pullRequestBranches.master` и
`pullRequestBranches.staging` должны отличаться.

Перед публикацией feature-ветки CLI fetch-ит настроенные target-ветки в
remote-tracking refs. Это позволяет `gh pr create --fill` корректно вычислять
title/body, даже если target-ветка ещё не была fetched в локальном репозитории.

Объекты `pullRequestBranches` объединяются по обычному приоритету
CLI → repository → defaults. Например, repository override может изменить
только `staging`, сохранив `master` из defaults.

## Как определяется репозиторий

Сначала CLI выполняет из текущей директории:

```bash
git rev-parse --show-toplevel
```

Так находится настоящий repository root даже при запуске из вложенной
директории. Все последующие команды `git` и `gh` запускаются с `cwd`, равным
этому root.

Затем CLI получает `nameWithOwner`:

```bash
gh repo view --json nameWithOwner --jq .nameWithOwner
```

Если это невозможно, используется:

```bash
git remote get-url origin
```

Поддерживаются HTTPS, SSH URL и SCP-подобный формат
`git@github.com:owner/repository.git`. Имя локальной директории не используется
как идентификатор репозитория. Вне Git-репозитория CLI завершается с понятной
ошибкой.

## Значения ClickUp

Custom fields должны быть текстовыми. CLI хранит одну строку на репозиторий:

```text
company/frontend: feat/86cavbfx9
company/backend: feat/86cavbfx9
```

Production и staging pull requests записываются в отдельные custom fields,
настроенные через `productionPullRequestFieldId` и
`stagingPullRequestFieldId`. В каждом поле сохраняется название репозитория и
ссылка на соответствующий PR:

```text
company/frontend: https://github.com/company/frontend/pull/124
company/backend: https://github.com/company/backend/pull/44
```

Повторный запуск обновляет только строку текущего `owner/repository`; строки и
прочие непустые данные других репозиториев сохраняются.
