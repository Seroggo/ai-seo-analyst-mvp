import { useState } from 'react'
import './App.css'

const FUNCTION_URL = import.meta.env.VITE_SUPABASE_FUNCTION_URL
const DEMO_TOKEN = import.meta.env.VITE_DEMO_TOKEN

const REPORT_FOCUSES = [
  { key: 'overview', label: 'Общий обзор' },
  { key: 'problem_projects', label: 'Топ проблемных проектов' },
  { key: 'stale_data_projects', label: 'Проекты без свежих данных' },
  { key: 'critical_top10_projects', label: 'Критически низкий TOP-10' },
  { key: 'attention_queue', label: 'Проекты требуют внимания' },
]

const buildPayload = (reportFocus) => ({
  mode: 'portfolio_report_auto',
  date: '2026-06-29',
  report_mode: 'latest_available',
  report_focus: reportFocus,
})

function App() {
  const [status, setStatus] = useState('idle')
  const [report, setReport] = useState('')
  const [error, setError] = useState('')
  const [activeFocus, setActiveFocus] = useState(null)

  const handleGenerateReport = async (reportFocus) => {
    setActiveFocus(reportFocus)
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

      const payload = buildPayload(reportFocus)

      const response = await fetch(FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-token': DEMO_TOKEN,
        },
        body: JSON.stringify(payload),
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
    } finally {
      setActiveFocus(null)
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
          <button
            onClick={() => handleGenerateReport('overview')}
            disabled={status === 'loading'}
            className={activeFocus === 'overview' ? 'scenario-active' : ''}
          >
            {activeFocus === 'overview' ? 'Формируем...' : 'Краткий SEO-отчёт'}
          </button>
        </div>

        <div className="scenario-grid" aria-label="Сценарии отчётов">
          {REPORT_FOCUSES.filter(f => f.key !== 'overview').map(({ key, label }) => (
            <button
              key={key}
              onClick={() => handleGenerateReport(key)}
              disabled={status === 'loading'}
              className={activeFocus === key ? 'scenario-active' : ''}
            >
              {activeFocus === key ? 'Формируем...' : label}
            </button>
          ))}
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
