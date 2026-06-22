# AI SEO Analyst MVP

MVP-проект backend-контура для AI SEO Analyst — сервиса, который в дальнейшем будет анализировать SEO-данные, формировать отчёты и отдавать их через API.

На текущем этапе реализован только базовый backend core на Supabase Edge Functions.

## Current stage / Текущий этап

Supabase backend core.

Цель этапа — доказать рабочую связку:

```text
локальный проект → Supabase Edge Function → deploy → public URL → JSON response
```

## Implemented / Что реализовано

* Инициализирован локальный Supabase-проект.
* Создана Edge Function `summary-report`.
* Реализован тестовый mock JSON-ответ.
* Добавлены базовые CORS-заголовки.
* Функция задеплоена в Supabase.
* Публичный endpoint проверен через PowerShell.
* Добавлен `.gitignore` для защиты от случайной публикации секретов.

## Endpoint

```text
https://zrbujphgaxhofqmmbqhv.supabase.co/functions/v1/summary-report
```

## Current response / Текущий ответ функции

```json
{
  "ok": true,
  "service": "ai-seo-analyst",
  "scenario": "summary-report",
  "mode": "mock",
  "message": "Supabase backend core is working"
}
```

## Project structure / Структура проекта

```text
ai-seo-analyst-mvp/
  supabase/
    functions/
      summary-report/
        index.ts
  docs/
    project-overview.md
  README.md
  .gitignore
```

## Not included yet / Что пока не входит в этап

* TopVisor API integration
* LLM / GPTunnel / OpenAI integration
* frontend
* Vercel deploy
* database cache
* usage limits
* analytical scenarios
* Google Sheets
* dashboard

## Next stage / Следующий этап

Следующий логичный этап — подключение реального источника SEO-данных или подготовка backend-слоя под будущую интеграцию с TopVisor API.
