import { useState } from 'react'
import './App.css'

const FUNCTION_URL = import.meta.env.VITE_SUPABASE_FUNCTION_URL
const DEMO_TOKEN = import.meta.env.VITE_DEMO_TOKEN

const DEMO_PAYLOAD = {
  mode: 'portfolio_report',
  date: '2026-06-07',
  report_mode: 'latest_available',
  projects: [
    {
      project_id: 27366644,
      region_index: 84,
    },
  ],
}

function App() {
  const [status, setStatus] = useState('idle')
  const [report, setReport] = useState('')
  const [error, setError] = useState('')

  const handleGenerateReport = async () => {
    setStatus('loading')
    setReport('')
    setError('')

    try {
      if (!FUNCTION_URL) {
        throw new Error('Не задана переменная VITE_SUPABASE_FUNCTION_URL')
      }

      if (!DEMO_TOKEN) {
        throw new Error('Не задана переменная VITE_DEMO_TOKEN')
      }

      const response = await fetch(FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-token': DEMO_TOKEN,
        },
        body: JSON.stringify(DEMO_PAYLOAD),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data?.error || `Backend вернул ошибку ${response.status}`)
      }

      const markdown = data?.report?.content

      if (!markdown) {
        throw new Error('В ответе backend не найдено поле report.content')
      }

      setReport(markdown)
      setStatus('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Неизвестная ошибка')
      setStatus('error')
    }
  }

  const statusText = {
    idle: 'Готово к запуску.',
    loading: 'Формируем отчёт...',
    success: 'Отчёт сформирован.',
    error: 'Ошибка при формировании отчёта.',
  }[status]

  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">AI SEO Analyst MVP</p>
        <h1>AI SEO Analyst Demo</h1>
        
        <div className="actions">
          <button onClick={handleGenerateReport} disabled={status === 'loading'}>
            {status === 'loading' ? 'Формируем...' : 'Краткий SEO-отчёт'}
          </button>
        </div>

        <div className="scenario-grid" aria-label="Будущие сценарии">
          <button disabled>Топ проблемных проектов</button>
          <button disabled>Проекты без свежих данных</button>
          <button disabled>Критически низкий TOP-10</button>
          <button disabled>Проекты требуют внимания</button>
        </div>
      </section>

      <section className="panel">
        <div className={`status status-${status}`}>{statusText}</div>

        {error && (
          <div className="error">
            <strong>Ошибка:</strong> {error}
          </div>
        )}

        {report && (
          <article className="report">
            <pre>{report}</pre>
          </article>
        )}
      </section>
    </main>
  )
}

export default App
