'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────
type Company = { corp_code: string; corp_name: string; corp_eng_name: string; stock_code: string }
type Disclosure = { rcept_no: string; corp_cls: string; corp_name: string; corp_code: string; stock_code: string; report_nm: string; rcept_dt: string; flr_nm: string; rm: string }
type FinancialResult = { financial_data: string; source_file: string; rcept_no: string } | { error: string }
type Tab = '공시목록' | '재무추이' | '키워드검색'
type TrendEntry = { year: string; rcept_no: string; report_nm: string; data: FinancialResult | null; loading: boolean; metrics?: Record<string, string> }
type Preset = { id: string; label: string; bgn: string; end: string }

// ── Constants ──────────────────────────────────────────────────────────────
const CORP_CLS: Record<string, string> = { Y: '유가', K: '코스닥', N: '코넥스', E: '기타' }

const PBLNTF_OPTIONS = [
  { value: '', label: '전체' },
  { value: 'A', label: '정기공시' },
  { value: 'B', label: '주요사항' },
  { value: 'C', label: '발행공시' },
  { value: 'D', label: '지분공시' },
  { value: 'E', label: '기타공시' },
  { value: 'F', label: '외부감사' },
  { value: 'G', label: '펀드공시' },
  { value: 'I', label: '거래소공시' },
]


// ── Helpers ────────────────────────────────────────────────────────────────
const fmtDate = (s: string) => `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6)}`
const toInputDate = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`
const fromInputDate = (s: string) => s.replace(/-/g, '')
const dartViewerUrl = (rceptNo: string) => `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function offsetYear(n: number) {
  const d = new Date()
  d.setFullYear(d.getFullYear() + n)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function buildPresets(): Preset[] {
  const today = todayStr()
  const y = new Date().getFullYear()
  return [
    { id: '1y', label: '1Y', bgn: offsetYear(-1), end: today },
    { id: '2y', label: '2Y', bgn: offsetYear(-2), end: today },
    { id: '3y', label: '3Y', bgn: offsetYear(-3), end: today },
    { id: '5y', label: '5Y', bgn: offsetYear(-5), end: today },
    ...Array.from({ length: 5 }, (_, i) => {
      const fy = y - i
      return { id: `fy${fy}`, label: `FY${String(fy).slice(2)}`, bgn: `${fy}0101`, end: fy === y ? today : `${fy}1231` }
    }),
  ]
}

// 숫자 추출: 콤마 포함 3자리 이상 숫자 (천원/원 모두)
function numericCells(parts: string[]): string[] {
  return parts.slice(1).filter(p => {
    const c = p.replace(/[\s,\(\)△▲]/g, '')
    return /^-?\d{3,}$/.test(c) && c.length > 0
  })
}

function pickNum(parts: string[]): string | undefined {
  return numericCells(parts)[0]
}

// 계정명 셀(첫 번째 셀)에만 매칭 — ^ 앵커로 "자산 및 자본 합계" 오매칭 방지
const METRIC_PATTERNS: { key: string; re: RegExp }[] = [
  // 재무상태표
  { key: '자산총계', re: /^자\s*산\s*(총|합)\s*계|^부\s*채\s*및\s*자\s*본\s*(총|합)\s*계|^자\s*산\s*합\s*계/ },
  { key: '부채총계', re: /^부\s*채\s*(총|합)\s*계/ },
  { key: '자본총계', re: /^자\s*본\s*(총|합)\s*계|^순\s*자\s*산\s*(총|합)\s*계/ },
  // 손익계산서 — 은행/일반 모두 커버
  { key: '매출액', re: /^매\s*출\s*액|^영\s*업\s*수\s*익(?!비)|^이\s*자\s*수\s*익\s*(합\s*계)?$|^순\s*영\s*업\s*수\s*익/ },
  { key: '영업이익', re: /^영\s*업\s*(이익|손익|이익\s*\(손실\))/ },
  { key: '당기순이익', re: /^당\s*기\s*순\s*(이익|손익|이익\s*\(손실\))/ },
]

function getMetricLines(text: string, key: string): string[] {
  const parts = text.split(/=== (.+?) ===\n?/)
  const blocks: { title: string; body: string }[] = []

  for (let i = 1; i < parts.length; i += 2) {
    blocks.push({ title: parts[i].replace(/\s/g, ''), body: parts[i + 1] || '' })
  }

  const isBalanceMetric = key === '자산총계' || key === '부채총계' || key === '자본총계'
  const relevant = blocks.filter(({ title }) => {
    if (isBalanceMetric) return title.includes('재무상태표') || title.includes('대차대조표')
    return title.includes('손익계산서')
  })

  const source = relevant.length > 0 ? relevant.map(b => b.body).join('\n') : text
  return source.split('\n').filter(l => l.includes('|'))
}

// "I. 매출액(주석 13)" / "Ⅰ. 매출액(주석14)" → "매출액" — 로마숫자 prefix·주석 제거
// DART 감사보고서별로 ASCII(I V X)와 Unicode(Ⅰ Ⅴ Ⅹ U+2160-2188) 혼용
function normalizeAccountCell(cell: string): string {
  return cell
    .replace(/^[Ⅰ-ↈIVXLCDMivxlcdm]+\.\s*/, '')  // ASCII+Unicode 로마 숫자 prefix
    .replace(/^\(\d+\)\s*/, '')               // (1) (2) 순번 prefix
    .replace(/^\d+\.\s*/, '')                 // 1. 2. 숫자 prefix
    .replace(/\(주\s*석\s*[\d,]+\)/g, '')     // (주석 N) / (주석 N,M) 각주 참조
    .replace(/\(\*+\d*\)/g, '')              // (*1) (*2) 각주 마커
    .trim()
}

function extractMetrics(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  const allLines = text.split('\n').filter(l => l.includes('|'))

  for (const { key, re } of METRIC_PATTERNS) {
    const findBest = (lines: string[]) => {
      let best: string[] | null = null
      let bestScore = -1
      let bestExactness = -1

      for (const line of lines) {
        const parts = line.split('|').map(s => s.trim())
        // "I." → normalize 후 "" → parts[1] fallback
        // "I. 매출액(주석 13)" → "매출액" (single cell)
        // "" | "매출액" → parts[1] fallback (빈 첫 셀)
        const norm0 = normalizeAccountCell(parts[0])
        const norm1 = normalizeAccountCell(parts[1] || '')
        const accountCell = norm0.length > 0 ? norm0 : norm1
        if (re.test(accountCell)) {
          const normalizedAccount = accountCell.replace(/\s/g, '')
          const exactness = normalizedAccount === key ? 2 : normalizedAccount.includes(key) ? 1 : 0
          const score = numericCells(parts).length
          if (score === 0) continue
          if (exactness > bestExactness || (exactness === bestExactness && score > bestScore)) {
            best = parts
            bestScore = score
            bestExactness = exactness
          }
        }
      }

      return best
    }

    const best = findBest(getMetricLines(text, key)) || findBest(allLines)
    if (best) {
      const val = pickNum(best)
      if (val) result[key] = val
    }
  }
  return result
}

// 회계연도 추출: 보고서명의 "(YYYY.MM)" 우선, 없으면 접수연도 (Q1 접수면 전년도)
function extractFiscalYear(reportNm: string, rceptDt: string): string {
  const m = reportNm.match(/\((\d{4})\.\d{2}\)/)
  if (m) return m[1]
  const y = parseInt(rceptDt.slice(0, 4))
  const mo = parseInt(rceptDt.slice(4, 6))
  return mo <= 4 ? String(y - 1) : String(y)
}

// 전체 재무제표 텍스트 → 섹션별 파싱
function parseFinancialSections(text: string): { title: string; rows: string[][] }[] {
  const sections: { title: string; rows: string[][] }[] = []
  const parts = text.split(/=== (.+?) ===\n?/)
  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i]
    const body = parts[i + 1] || ''
    const rows = body.split('\n')
      .filter(l => l.includes('|'))
      .map(l => l.split('|').map(s => s.trim()))
      .filter(r => r.some(c => c.length > 0))
    if (rows.length > 0) sections.push({ title, rows })
  }
  return sections
}

// ── Component ──────────────────────────────────────────────────────────────
export default function DartCommandCenter() {
  // ── sidebar state
  const [query, setQuery] = useState('')
  const [companies, setCompanies] = useState<Company[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [selected, setSelected] = useState<Company | null>(null)
  const [recents, setRecents] = useState<Company[]>([])
  const [watchlist, setWatchlist] = useState<Company[]>([])

  // ── tabs
  const [activeTab, setActiveTab] = useState<Tab>('공시목록')

  // ── 공시목록 state
  const PRESETS = useMemo(() => buildPresets(), [])
  const [bgn, setBgn] = useState(() => offsetYear(-1))
  const [end, setEnd] = useState(todayStr)
  const [activePreset, setActivePreset] = useState<string | null>(null)
  const [pblntf, setPblntf] = useState('')
  const [disclosures, setDisclosures] = useState<Disclosure[]>([])
  const [discLoading, setDiscLoading] = useState(false)
  // ── 재무추이 state
  const [trend, setTrend] = useState<TrendEntry[]>([])
  const [trendLoading, setTrendLoading] = useState(false)
  const [expandedRcept, setExpandedRcept] = useState<string | null>(null)

  // ── 키워드검색 state
  const [kw, setKw] = useState('')
  const [kwPblntf, setKwPblntf] = useState('B')
  const [kwBgn, setKwBgn] = useState(() => offsetYear(-1))
  const [kwEnd, setKwEnd] = useState(todayStr)
  const [kwResults, setKwResults] = useState<Disclosure[]>([])
  const [kwLoading, setKwLoading] = useState(false)
  const [kwSearched, setKwSearched] = useState(false)

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trendCorpRef = useRef<string | null>(null) // 마지막 로드된 corp_code 추적

  // ── localStorage init
  useEffect(() => {
    try {
      const r = localStorage.getItem('dart-cc-recents')
      if (r) setRecents(JSON.parse(r))
      const w = localStorage.getItem('dart-cc-watchlist')
      if (w) setWatchlist(JSON.parse(w))
    } catch {}
  }, [])

  // ── company search
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    if (!query.trim()) { setCompanies([]); return }
    debounce.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const r = await fetch(`/api/companies?q=${encodeURIComponent(query)}`)
        setCompanies(await r.json())
      } finally { setSearchLoading(false) }
    }, 250)
  }, [query])

  // ── 공시목록 load (공시목록 탭에서만 실행)
  const loadDisclosures = useCallback(async () => {
    if (!selected || activeTab !== '공시목록') return
    setDiscLoading(true)
    try {
      const p = new URLSearchParams({
        corp_code: selected.corp_code,
        bgn_de: bgn, end_de: end,
        ...(pblntf ? { pblntf_ty: pblntf } : {}),
        page_count: '100',
      })
      const r = await fetch(`/api/disclosures?${p}`)
      const data = await r.json()
      setDisclosures(data.list || [])
    } finally { setDiscLoading(false) }
  }, [selected, bgn, end, pblntf, activeTab])

  useEffect(() => { loadDisclosures() }, [loadDisclosures])

  // ── 재무추이 load (같은 회사 탭 재진입 시 재호출 방지)
  const loadTrend = useCallback(async () => {
    if (!selected) return
    if (trendCorpRef.current === selected.corp_code) return // 이미 로드됨
    trendCorpRef.current = selected.corp_code
    setTrendLoading(true)
    setTrend([])
    try {
      // 전체 공시에서 연간 재무보고서 탐색 (사업보고서 + 감사보고서 모두 커버)
      const p = new URLSearchParams({
        corp_code: selected.corp_code,
        bgn_de: offsetYear(-6),
        end_de: todayStr(),
        page_count: '100',
      })
      const r = await fetch(`/api/disclosures?${p}`)
      const data = await r.json()
      const ANNUAL_PATTERNS = ['사업보고서', '감사보고서', '연결감사보고서']
      const annuals: Disclosure[] = (data.list || [])
        .filter((d: Disclosure) =>
          ANNUAL_PATTERNS.some(pat => d.report_nm.includes(pat)) &&
          !d.report_nm.includes('기재정정') &&
          !d.report_nm.includes('반기') &&
          !d.report_nm.includes('분기')
        )
        // 같은 회계연도 중복 제거 (접수연도 기준X → 회계연도 기준으로 수정)
        .reduce((acc: Disclosure[], d: Disclosure) => {
          const fy = extractFiscalYear(d.report_nm, d.rcept_dt)
          if (!acc.find(a => extractFiscalYear(a.report_nm, a.rcept_dt) === fy)) acc.push(d)
          return acc
        }, [])
        .slice(0, 4)
        .reverse()  // 오래된 연도 → 최신 연도 (왼→오)

      if (!annuals.length) { setTrendLoading(false); return }

      const entries: TrendEntry[] = annuals.map(d => ({
        year: extractFiscalYear(d.report_nm, d.rcept_dt), // 회계연도 기준
        rcept_no: d.rcept_no,
        report_nm: d.report_nm,
        data: null,
        loading: true,
      }))
      setTrend(entries)
      setTrendLoading(false)

      // fetch financial data in parallel
      const results = await Promise.all(
        annuals.map(d => fetch(`/api/financial/${d.rcept_no}`).then(r => r.json()).catch(() => ({ error: '네트워크 오류' })))
      )
      setTrend(entries.map((e, i) => {
        const data = results[i] as FinancialResult
        const metrics = data && 'financial_data' in data ? extractMetrics(data.financial_data) : undefined
        return { ...e, data, loading: false, metrics }
      }))
    } catch {
      trendCorpRef.current = null // 실패 시 재시도 허용
      setTrendLoading(false)
    }
  }, [selected])

  useEffect(() => {
    if (activeTab === '재무추이' && selected) loadTrend()
  }, [activeTab, loadTrend, selected])

  // ── watchlist & recents helpers
  const saveRecent = (co: Company) => {
    setRecents(prev => {
      const next = [co, ...prev.filter(c => c.corp_code !== co.corp_code)].slice(0, 8)
      try { localStorage.setItem('dart-cc-recents', JSON.stringify(next)) } catch {}
      return next
    })
  }
  const removeRecent = (corp_code: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setRecents(prev => {
      const next = prev.filter(c => c.corp_code !== corp_code)
      try { localStorage.setItem('dart-cc-recents', JSON.stringify(next)) } catch {}
      return next
    })
  }
  const toggleWatch = (co: Company, e: React.MouseEvent) => {
    e.stopPropagation()
    setWatchlist(prev => {
      const exists = prev.some(c => c.corp_code === co.corp_code)
      const next = exists ? prev.filter(c => c.corp_code !== co.corp_code) : [co, ...prev].slice(0, 20)
      try { localStorage.setItem('dart-cc-watchlist', JSON.stringify(next)) } catch {}
      return next
    })
  }
  const isWatched = (corp_code: string) => watchlist.some(c => c.corp_code === corp_code)

  // 탭 유지하며 회사 선택 (사이드바 클릭)
  const selectCompany = (co: Company) => {
    if (co.corp_code !== selected?.corp_code) {
      trendCorpRef.current = null // 다른 회사 선택 시 캐시 초기화
    }
    setSelected(co)
    saveRecent(co)
    setExpandedRcept(null)
  }
  // 키워드 검색 결과에서 회사 클릭 → 공시목록으로 이동
  const selectAndGoDisc = (co: Company) => {
    setSelected(co)
    saveRecent(co)
    setExpandedRcept(null)
    setActiveTab('공시목록')
  }

  // ── 키워드 검색
  const doSearch = async () => {
    setKwLoading(true); setKwSearched(true); setKwResults([])
    try {
      const p = new URLSearchParams({
        bgn_de: kwBgn, end_de: kwEnd,
        ...(kwPblntf ? { pblntf_ty: kwPblntf } : {}),
        page_count: '100',
      })
      const r = await fetch(`/api/disclosures?${p}`)
      const data = await r.json()
      const all: Disclosure[] = data.list || []
      const keyword = kw.trim().toLowerCase()
      setKwResults(keyword
        ? all.filter(d => d.report_nm.toLowerCase().includes(keyword) || d.corp_name.toLowerCase().includes(keyword))
        : all
      )
    } finally { setKwLoading(false) }
  }

  // ── presets
  const applyPreset = (p: Preset) => { setBgn(p.bgn); setEnd(p.end); setActivePreset(p.id) }

  // ── Shared company row renderer
  const CompanyRow = ({ co, section }: { co: Company; section: 'search' | 'watch' | 'recent' }) => (
    <button
      onClick={() => selectCompany(co)}
      className={`w-full text-left px-3 py-2 border-b border-gray-100 transition-colors group ${
        selected?.corp_code === co.corp_code ? 'bg-black text-white' : 'hover:bg-gray-50'
      }`}
    >
      <div className="flex items-center justify-between gap-1">
        <div className="font-semibold truncate">{co.corp_name}</div>
        <div className="flex gap-1 flex-shrink-0">
          <span
            onClick={e => toggleWatch(co, e)}
            title={isWatched(co.corp_code) ? '즐겨찾기 해제' : '즐겨찾기 추가'}
            className={`px-1 transition-opacity ${
              isWatched(co.corp_code)
                ? 'opacity-100 text-black'
                : 'opacity-0 group-hover:opacity-100 text-gray-300 hover:text-black'
            } ${selected?.corp_code === co.corp_code ? 'text-white hover:text-gray-300' : ''}`}
          >
            {isWatched(co.corp_code) ? '★' : '☆'}
          </span>
          {section === 'recent' && (
            <span
              onClick={e => removeRecent(co.corp_code, e)}
              className={`px-1 opacity-0 group-hover:opacity-100 transition-opacity ${
                selected?.corp_code === co.corp_code ? 'text-gray-400 hover:text-gray-200' : 'text-gray-300 hover:text-black'
              }`}
            >✕</span>
          )}
        </div>
      </div>
      <div className={`text-[10px] mt-0.5 ${selected?.corp_code === co.corp_code ? 'text-gray-400' : 'text-gray-400'}`}>
        {co.stock_code ? `${co.stock_code} · 상장` : '비상장'} · {co.corp_code}
      </div>
    </button>
  )

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-white text-black font-mono text-xs overflow-hidden">

      {/* ── Sidebar ── */}
      <div className="w-64 border-r border-gray-200 flex flex-col flex-shrink-0">
        <div className="px-4 py-3 border-b border-gray-200">
          <button
            onClick={() => { setSelected(null); setDisclosures([]); setTrend([]); setActiveTab('공시목록'); setQuery('') }}
            className="text-left hover:opacity-70 transition-opacity w-full"
          >
            <div className="text-xs font-bold tracking-[0.15em] uppercase">DART CC</div>
            <div className="text-[10px] text-gray-400 mt-0.5">Command Center</div>
          </button>
        </div>

        <div className="px-3 py-2 border-b border-gray-100">
          <input
            type="text"
            placeholder="회사명 검색..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full px-2.5 py-1.5 border border-gray-200 focus:border-black focus:outline-none bg-white text-xs"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {searchLoading && <div className="px-3 py-2 text-gray-400">검색 중...</div>}

          {/* Search results */}
          {!searchLoading && query && companies.map(co => <CompanyRow key={co.corp_code} co={co} section="search" />)}
          {!searchLoading && query && companies.length === 0 && <div className="px-3 py-2 text-gray-400">결과 없음</div>}

          {/* Idle: watchlist + recents */}
          {!query && (
            <>
              {watchlist.length > 0 && (
                <>
                  <div className="px-3 py-1.5 text-[10px] text-gray-400 font-semibold tracking-wider uppercase border-b border-gray-100 flex items-center gap-1">
                    <span>★</span><span>즐겨찾기</span>
                  </div>
                  {watchlist.map(co => <CompanyRow key={co.corp_code} co={co} section="watch" />)}
                </>
              )}
              {recents.length > 0 && (
                <>
                  <div className="px-3 py-1.5 text-[10px] text-gray-400 font-semibold tracking-wider uppercase border-b border-gray-100">
                    최근 검색
                  </div>
                  {recents.map(co => <CompanyRow key={co.corp_code} co={co} section="recent" />)}
                </>
              )}
              {watchlist.length === 0 && recents.length === 0 && (
                <div className="px-3 py-2 text-gray-300">회사명을 입력하세요</div>
              )}
            </>
          )}
        </div>

        {selected && (
          <div className="px-3 py-2 border-t border-gray-200 bg-gray-50">
            <div className="flex items-center justify-between">
              <div className="font-bold truncate">{selected.corp_name}</div>
              <span onClick={e => toggleWatch(selected, e)} className="cursor-pointer flex-shrink-0 px-1">
                {isWatched(selected.corp_code) ? '★' : '☆'}
              </span>
            </div>
            <div className="text-[10px] text-gray-400 mt-0.5">
              {selected.corp_code} · {selected.stock_code || '비상장'}
            </div>
          </div>
        )}

        <div className="px-3 py-2 border-t border-gray-200 text-[10px] leading-relaxed text-gray-400 bg-white">
          <div>DART CC made by John Jongyoon Lee</div>
          <a href="mailto:john.jongyoon.lee@gmail.com" className="hover:text-black underline underline-offset-2">
            contact: john.jongyoon.lee@gmail.com
          </a>
        </div>
      </div>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Tab bar */}
        <div className="flex items-center border-b border-gray-200 bg-white flex-shrink-0">
          {(['공시목록', '재무추이', '키워드검색'] as Tab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 border-b-2 transition-colors font-semibold ${
                activeTab === tab
                  ? 'border-black text-black'
                  : 'border-transparent text-gray-400 hover:text-black'
              }`}
            >
              {tab}
            </button>
          ))}
          {selected && (
            <div className="ml-auto flex items-center gap-2 px-4 text-[10px] text-gray-400">
              <span>›</span>
              <span className="font-semibold text-black">{selected.corp_name}</span>
              <button
                onClick={() => { setSelected(null); setDisclosures([]); setTrend([]); trendCorpRef.current = null }}
                className="ml-1 text-gray-300 hover:text-black transition-colors"
                title="선택 해제"
              >✕</button>
            </div>
          )}
        </div>

        {/* ── Tab: 공시목록 ── */}
        {activeTab === '공시목록' && (
          <>
            {/* Filter bar */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-white flex-shrink-0 flex-wrap">
              <span className="text-gray-400">최근</span>
              {PRESETS.filter(p => p.id.endsWith('y')).map(p => (
                <button key={p.id} onClick={() => applyPreset(p)}
                  className={`px-2 py-0.5 border transition-colors ${activePreset === p.id ? 'bg-black text-white border-black' : 'border-gray-300 text-gray-500 hover:border-black hover:text-black'}`}>
                  {p.label}
                </button>
              ))}
              <div className="w-px h-4 bg-gray-200" />
              <span className="text-gray-400">FY</span>
              {PRESETS.filter(p => p.id.startsWith('fy')).map(p => (
                <button key={p.id} onClick={() => applyPreset(p)}
                  className={`px-2 py-0.5 border transition-colors ${activePreset === p.id ? 'bg-black text-white border-black' : 'border-gray-300 text-gray-500 hover:border-black hover:text-black'}`}>
                  {p.label}
                </button>
              ))}
              <div className="w-px h-4 bg-gray-200" />
              <input type="date" value={toInputDate(bgn)} onChange={e => { setBgn(fromInputDate(e.target.value)); setActivePreset(null) }}
                className="border border-gray-200 px-2 py-1 focus:border-black focus:outline-none bg-white" />
              <span className="text-gray-400">~</span>
              <input type="date" value={toInputDate(end)} onChange={e => { setEnd(fromInputDate(e.target.value)); setActivePreset(null) }}
                className="border border-gray-200 px-2 py-1 focus:border-black focus:outline-none bg-white" />
              <select value={pblntf} onChange={e => setPblntf(e.target.value)}
                className="border border-gray-200 px-2 py-1 focus:border-black focus:outline-none bg-white ml-1">
                {PBLNTF_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>

            {/* Table */}
            {!selected ? (
              <div className="flex-1 flex flex-col items-center justify-center text-gray-300 gap-2">
                <div className="text-3xl font-bold tracking-widest">DART</div>
                <div>왼쪽에서 회사를 검색하세요</div>
              </div>
            ) : discLoading ? (
              <div className="flex-1 flex items-center justify-center text-gray-400">공시 목록 로딩 중...</div>
            ) : disclosures.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-gray-400">해당 기간에 조회된 공시가 없습니다</div>
            ) : (
              <div className="flex-1 overflow-auto">
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-gray-50 border-b-2 border-gray-200 z-10">
                    <tr>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold w-28">접수일</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold w-16">구분</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold">보고서명</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold w-32">제출인</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold w-8">비고</th>
                    </tr>
                  </thead>
                  <tbody>
                    {disclosures.map(d => (
                      <tr key={d.rcept_no} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(d.rcept_dt)}</td>
                        <td className="px-3 py-2 text-gray-400">{CORP_CLS[d.corp_cls] || d.corp_cls}</td>
                        <td className="px-3 py-2 font-medium">
                          <a href={dartViewerUrl(d.rcept_no)} target="_blank" rel="noopener noreferrer"
                            className="text-black hover:underline">
                            {d.report_nm}
                          </a>
                        </td>
                        <td className="px-3 py-2 text-gray-400 truncate max-w-[128px]">{d.flr_nm}</td>
                        <td className="px-3 py-2 text-red-500 font-semibold">{d.rm}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="px-3 py-2 text-gray-400 border-t border-gray-100">
                  총 {disclosures.length}건
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Tab: 재무추이 ── */}
        {activeTab === '재무추이' && (
          <div className="flex-1 overflow-auto p-4">
            {!selected ? (
              <div className="flex items-center justify-center h-full text-gray-300">왼쪽에서 회사를 선택하세요</div>
            ) : trendLoading ? (
              <div className="flex items-center justify-center h-full text-gray-400">연간 보고서 조회 중...</div>
            ) : trend.length === 0 ? (
              <div className="flex items-center justify-center h-full text-gray-400">연간 보고서를 찾을 수 없습니다</div>
            ) : (
              <>
                <div className="text-[10px] text-gray-400 mb-3 flex items-center gap-2">
                  <span>{selected.corp_name} · 연간보고서 기준 · 단위는 보고서 원본 따름</span>
                  <button
                    onClick={() => { trendCorpRef.current = null; loadTrend() }}
                    className="text-gray-300 hover:text-black transition-colors"
                    title="재무데이터 새로고침"
                  >↺</button>
                </div>

                {/* Summary metrics table */}
                <table className="w-full border-collapse mb-4">
                  <thead>
                    <tr className="bg-gray-50 border-b-2 border-gray-200">
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold w-32">항목</th>
                      {trend.map(t => (
                        <th key={t.rcept_no} className="px-3 py-2 text-right text-gray-500 font-semibold min-w-[140px]">
                          <div>{t.year}</div>
                          <a href={dartViewerUrl(t.rcept_no)} target="_blank" rel="noopener noreferrer"
                            className="text-[10px] font-normal text-gray-400 hover:text-black hover:underline">
                            {t.report_nm}
                          </a>
                          <button
                            onClick={() => setExpandedRcept(expandedRcept === t.rcept_no ? null : t.rcept_no)}
                            className={`text-[10px] font-normal underline mt-0.5 block ml-auto transition-colors ${
                              expandedRcept === t.rcept_no ? 'text-black' : 'text-gray-300 hover:text-black'
                            }`}
                          >
                            {expandedRcept === t.rcept_no ? '▲ 접기' : '▼ 전체 보기'}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {METRIC_PATTERNS.map(({ key }) => {
                      const values = trend.map(t => {
                        if (t.loading) return '...'
                        if (!t.data || 'error' in t.data) return '-'
                        return t.metrics?.[key] || '-'
                      })
                      return (
                        <tr key={key} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="px-3 py-2 text-gray-600 font-medium">{key}</td>
                          {values.map((v, i) => (
                            <td key={i} className={`px-3 py-2 text-right font-mono tabular-nums ${
                              v === '-' || v === '...' ? 'text-gray-300' : 'text-black'
                            }`}>
                              {v}
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                {/* Inline full-text expansion */}
                {expandedRcept && (() => {
                  const entry = trend.find(t => t.rcept_no === expandedRcept)
                  if (!entry) return null
                  return (
                    <div className="border border-gray-200 mb-4">
                      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
                        <span className="font-semibold text-sm">
                          {entry.year} ·{' '}
                          <a href={dartViewerUrl(entry.rcept_no)} target="_blank" rel="noopener noreferrer"
                            className="hover:underline">
                            {entry.report_nm}
                          </a>
                          {' '}— 전체 재무제표
                        </span>
                        <div className="flex gap-3 items-center">
                          <button onClick={() => setExpandedRcept(null)} className="text-gray-400 hover:text-black">✕</button>
                        </div>
                      </div>
                      <div className="overflow-auto max-h-[65vh]">
                        {entry.loading && <div className="px-4 py-6 text-gray-400">로딩 중...</div>}
                        {!entry.loading && entry.data && 'error' in entry.data && (
                          <div className="px-4 py-4 text-red-500">{entry.data.error}</div>
                        )}
                        {!entry.loading && entry.data && 'financial_data' in entry.data && (() => {
                          const sections = parseFinancialSections(entry.data.financial_data)
                          if (sections.length === 0) return (
                            <pre className="p-4 text-xs whitespace-pre-wrap font-mono">{entry.data.financial_data}</pre>
                          )
                          return (
                            <div className="divide-y divide-gray-100">
                              {sections.map((sec, secIndex) => {
                                // 헤더 행 감지: 첫 번째 셀이 비어있고 나머지에 연도/기간 텍스트
                                const hasHeader = sec.rows[0]?.[0] === '' || /당기|전기|기말|기초|\d{4}/.test(sec.rows[0]?.[1] || '')
                                const headerRow = hasHeader ? sec.rows[0] : null
                                const dataRows = hasHeader ? sec.rows.slice(1) : sec.rows
                                return (
                                  <div key={`${sec.title}-${secIndex}`} className="px-4 py-4">
                                    <div className="font-bold text-xs mb-3 text-black">{sec.title}</div>
                                    <table className="w-full border-collapse text-xs">
                                      {headerRow && (
                                        <thead>
                                          <tr className="border-b border-gray-200">
                                            {headerRow.map((h, j) => (
                                              <th key={j} className={`py-1 text-gray-500 font-semibold ${j === 0 ? 'text-left pr-4' : 'text-right px-3'}`}>
                                                {h}
                                              </th>
                                            ))}
                                          </tr>
                                        </thead>
                                      )}
                                      <tbody>
                                        {dataRows.map((row, i) => {
                                          const isTotal = /합\s*계|총\s*계/.test(row[0] || '')
                                          return (
                                            <tr key={i} className={`border-b border-gray-50 hover:bg-gray-50 ${isTotal ? 'font-bold border-t border-gray-200' : ''}`}>
                                              <td className="py-1 pr-4 text-gray-700 w-60 min-w-[160px]">{row[0]}</td>
                                              {row.slice(1).map((v, j) => (
                                                <td key={j} className={`py-1 px-3 text-right font-mono tabular-nums ${v === '-' || v === '' ? 'text-gray-300' : 'text-black'}`}>
                                                  {v || '–'}
                                                </td>
                                              ))}
                                            </tr>
                                          )
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                )
                              })}
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                  )
                })()}

                {/* Footer links */}
                <div className="flex gap-4 flex-wrap text-[10px] text-gray-400">
                  {trend.map(t => (
                    <span key={t.rcept_no}>
                      {t.year}
                      {t.data && 'error' in t.data && <span className="text-red-400 ml-1">({t.data.error})</span>}
                      {' · '}
                      <a href={dartViewerUrl(t.rcept_no)}
                        target="_blank" rel="noopener noreferrer" className="underline hover:text-black">원문</a>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Tab: 키워드검색 ── */}
        {activeTab === '키워드검색' && (
          <>
            {/* Search bar */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 flex-shrink-0 flex-wrap">
              <input
                type="text"
                placeholder="키워드 (보고서명·회사명)"
                value={kw}
                onChange={e => setKw(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && doSearch()}
                className="border border-gray-200 px-3 py-1.5 focus:border-black focus:outline-none bg-white w-52"
              />
              <select value={kwPblntf} onChange={e => setKwPblntf(e.target.value)}
                className="border border-gray-200 px-2 py-1.5 focus:border-black focus:outline-none bg-white">
                {PBLNTF_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <input type="date" value={toInputDate(kwBgn)} onChange={e => setKwBgn(fromInputDate(e.target.value))}
                className="border border-gray-200 px-2 py-1.5 focus:border-black focus:outline-none bg-white" />
              <span className="text-gray-400">~</span>
              <input type="date" value={toInputDate(kwEnd)} onChange={e => setKwEnd(fromInputDate(e.target.value))}
                className="border border-gray-200 px-2 py-1.5 focus:border-black focus:outline-none bg-white" />
              <button onClick={doSearch} disabled={kwLoading}
                className="px-4 py-1.5 bg-black text-white hover:bg-gray-800 transition-colors font-semibold disabled:opacity-50">
                {kwLoading ? '검색 중...' : '검색'}
              </button>
              {kwSearched && !kwLoading && (
                <span className="text-gray-400">{kwResults.length}건</span>
              )}
            </div>

            {/* Results */}
            {!kwSearched ? (
              <div className="flex-1 flex flex-col items-center justify-center text-gray-300 gap-2">
                <div className="text-2xl font-bold tracking-widest">검색</div>
                <div>키워드·기간·구분 설정 후 검색하세요</div>
                <div className="text-[10px] mt-1">예: 유상증자, 합병, 영업양도, 자기주식</div>
              </div>
            ) : kwLoading ? (
              <div className="flex-1 flex items-center justify-center text-gray-400">검색 중...</div>
            ) : kwResults.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-gray-400">검색 결과가 없습니다</div>
            ) : (
              <div className="flex-1 overflow-auto">
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-gray-50 border-b-2 border-gray-200 z-10">
                    <tr>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold w-28">접수일</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold w-40">회사명</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold">보고서명</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold w-28">제출인</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kwResults.map(d => (
                      <tr key={d.rcept_no} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(d.rcept_dt)}</td>
                        <td className="px-3 py-2 font-semibold">
                          <button onClick={() => selectAndGoDisc({ corp_code: d.corp_code, corp_name: d.corp_name, corp_eng_name: '', stock_code: d.stock_code })}
                            className="hover:underline text-left">
                            {d.corp_name}
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          <a href={dartViewerUrl(d.rcept_no)} target="_blank" rel="noopener noreferrer"
                            className="text-black hover:underline">
                            {d.report_nm}
                          </a>
                        </td>
                        <td className="px-3 py-2 text-gray-400 truncate max-w-[112px]">{d.flr_nm}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

    </div>
  )
}
