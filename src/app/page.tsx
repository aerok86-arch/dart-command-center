'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

type Company = {
  corp_code: string
  corp_name: string
  corp_eng_name: string
  stock_code: string
}

type Disclosure = {
  rcept_no: string
  corp_cls: string
  corp_name: string
  corp_code: string
  stock_code: string
  report_nm: string
  rcept_dt: string
  flr_nm: string
  rm: string
}

type FinancialResult =
  | { financial_data: string; source_file: string; rcept_no: string }
  | { error: string }

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

function fmtDate(s: string) {
  return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6)}`
}

function toInputDate(s: string) {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`
}

function fromInputDate(s: string) {
  return s.replace(/-/g, '')
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function defaultBgn() {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function defaultEnd() {
  return todayStr()
}

type Preset = { id: string; label: string; bgn: string; end: string }

function buildPresets(): Preset[] {
  const now = new Date()
  const today = todayStr()
  const y = now.getFullYear()

  const shiftYear = (n: number) => {
    const d = new Date(now)
    d.setFullYear(d.getFullYear() + n)
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  }

  const recents: Preset[] = [
    { id: '1y', label: '1Y', bgn: shiftYear(-1), end: today },
    { id: '2y', label: '2Y', bgn: shiftYear(-2), end: today },
    { id: '3y', label: '3Y', bgn: shiftYear(-3), end: today },
    { id: '5y', label: '5Y', bgn: shiftYear(-5), end: today },
  ]

  const fys: Preset[] = Array.from({ length: 5 }, (_, i) => {
    const fy = y - i
    return {
      id: `fy${fy}`,
      label: `FY${String(fy).slice(2)}`,
      bgn: `${fy}0101`,
      end: fy === y ? today : `${fy}1231`,
    }
  })

  return [...recents, ...fys]
}

export default function DartCommandCenter() {
  const [query, setQuery] = useState('')
  const [companies, setCompanies] = useState<Company[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [selected, setSelected] = useState<Company | null>(null)

  const PRESETS = buildPresets()
  const [bgn, setBgn] = useState(defaultBgn)
  const [end, setEnd] = useState(defaultEnd)
  const [activePreset, setActivePreset] = useState<string | null>(null)
  const [pblntf, setPblntf] = useState('')

  const applyPreset = (p: Preset) => {
    setBgn(p.bgn)
    setEnd(p.end)
    setActivePreset(p.id)
  }

  const [disclosures, setDisclosures] = useState<Disclosure[]>([])
  const [discLoading, setDiscLoading] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const [modal, setModal] = useState<{ rcept_no: string; report_nm: string } | null>(null)
  const [financial, setFinancial] = useState<FinancialResult | null>(null)
  const [finLoading, setFinLoading] = useState(false)

  const [downloading, setDownloading] = useState<Set<string>>(new Set())

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // ── load disclosures
  const loadDisclosures = useCallback(async () => {
    if (!selected) return
    setDiscLoading(true)
    setChecked(new Set())
    try {
      const p = new URLSearchParams({
        corp_code: selected.corp_code,
        bgn_de: bgn,
        end_de: end,
        ...(pblntf ? { pblntf_ty: pblntf } : {}),
        page_count: '100',
      })
      const r = await fetch(`/api/disclosures?${p}`)
      const data = await r.json()
      setDisclosures(data.list || [])
    } finally { setDiscLoading(false) }
  }, [selected, bgn, end, pblntf])

  useEffect(() => { loadDisclosures() }, [loadDisclosures])

  // ── selection
  const toggleOne = (id: string) =>
    setChecked(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const toggleAll = () =>
    setChecked(checked.size === disclosures.length ? new Set() : new Set(disclosures.map(d => d.rcept_no)))

  // ── download
  const downloadZip = async (rcept_no: string) => {
    setDownloading(p => new Set([...p, rcept_no]))
    const link = document.createElement('a')
    link.href = `/api/document/${rcept_no}`
    link.download = `${rcept_no}.zip`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    setTimeout(() => setDownloading(p => { const n = new Set(p); n.delete(rcept_no); return n }), 2000)
  }

  const batchDownload = async () => {
    for (const id of Array.from(checked)) {
      await downloadZip(id)
      await new Promise(r => setTimeout(r, 700))
    }
  }

  // ── financial modal
  const openFinancial = async (rcept_no: string, report_nm: string) => {
    setModal({ rcept_no, report_nm })
    setFinancial(null)
    setFinLoading(true)
    try {
      const r = await fetch(`/api/financial/${rcept_no}`)
      setFinancial(await r.json())
    } finally { setFinLoading(false) }
  }

  const isAnnualType = (nm: string) =>
    /사업보고서|분기보고서|반기보고서|감사보고서/.test(nm)

  return (
    <div className="flex h-screen bg-white text-black font-mono text-xs overflow-hidden">

      {/* ── Left Sidebar */}
      <div className="w-64 border-r border-gray-200 flex flex-col flex-shrink-0">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200">
          <div className="text-xs font-bold tracking-[0.15em] uppercase">DART CC</div>
          <div className="text-[10px] text-gray-400 mt-0.5">Command Center</div>
        </div>

        {/* Search input */}
        <div className="px-3 py-2 border-b border-gray-100">
          <input
            type="text"
            placeholder="회사명 검색..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full px-2.5 py-1.5 border border-gray-200 focus:border-black focus:outline-none bg-white text-xs"
          />
        </div>

        {/* Company list */}
        <div className="flex-1 overflow-y-auto">
          {searchLoading && <div className="px-3 py-2 text-gray-400">검색 중...</div>}

          {!searchLoading && companies.map(co => (
            <button
              key={co.corp_code}
              onClick={() => setSelected(co)}
              className={`w-full text-left px-3 py-2 border-b border-gray-100 transition-colors ${
                selected?.corp_code === co.corp_code
                  ? 'bg-black text-white'
                  : 'hover:bg-gray-50'
              }`}
            >
              <div className="font-semibold truncate">{co.corp_name}</div>
              <div className={`text-[10px] mt-0.5 ${selected?.corp_code === co.corp_code ? 'text-gray-400' : 'text-gray-400'}`}>
                {co.stock_code ? `${co.stock_code} · 상장` : '비상장'} · {co.corp_code}
              </div>
            </button>
          ))}

          {!searchLoading && companies.length === 0 && query && (
            <div className="px-3 py-2 text-gray-400">결과 없음</div>
          )}
          {!query && (
            <div className="px-3 py-2 text-gray-300">회사명을 입력하세요</div>
          )}
        </div>

        {/* Selected company footer */}
        {selected && (
          <div className="px-3 py-2 border-t border-gray-200 bg-gray-50">
            <div className="font-bold truncate">{selected.corp_name}</div>
            <div className="text-[10px] text-gray-400 mt-0.5">
              {selected.corp_code} · {selected.stock_code || '비상장'}
            </div>
          </div>
        )}
      </div>

      {/* ── Main Area */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Filter bar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-200 bg-white flex-shrink-0 flex-wrap">
          {/* Recent presets */}
          <div className="flex items-center gap-1">
            <span className="text-gray-400 mr-0.5">최근</span>
            {PRESETS.filter(p => p.id.endsWith('y')).map(p => (
              <button
                key={p.id}
                onClick={() => applyPreset(p)}
                className={`px-2 py-0.5 border transition-colors ${
                  activePreset === p.id
                    ? 'bg-black text-white border-black'
                    : 'border-gray-300 text-gray-500 hover:border-black hover:text-black'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="w-px h-4 bg-gray-200" />

          {/* FY presets */}
          <div className="flex items-center gap-1">
            <span className="text-gray-400 mr-0.5">FY</span>
            {PRESETS.filter(p => p.id.startsWith('fy')).map(p => (
              <button
                key={p.id}
                onClick={() => applyPreset(p)}
                className={`px-2 py-0.5 border transition-colors ${
                  activePreset === p.id
                    ? 'bg-black text-white border-black'
                    : 'border-gray-300 text-gray-500 hover:border-black hover:text-black'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="w-px h-4 bg-gray-200" />

          <span className="text-gray-400">기간</span>
          <input
            type="date"
            value={toInputDate(bgn)}
            onChange={e => { setBgn(fromInputDate(e.target.value)); setActivePreset(null) }}
            className="border border-gray-200 px-2 py-1 focus:border-black focus:outline-none bg-white"
          />
          <span className="text-gray-400">~</span>
          <input
            type="date"
            value={toInputDate(end)}
            onChange={e => { setEnd(fromInputDate(e.target.value)); setActivePreset(null) }}
            className="border border-gray-200 px-2 py-1 focus:border-black focus:outline-none bg-white"
          />

          <span className="text-gray-400 ml-2">구분</span>
          <select
            value={pblntf}
            onChange={e => setPblntf(e.target.value)}
            className="border border-gray-200 px-2 py-1 focus:border-black focus:outline-none bg-white"
          >
            {PBLNTF_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          <div className="flex-1" />

          {checked.size > 0 && (
            <button
              onClick={batchDownload}
              className="px-3 py-1.5 bg-black text-white hover:bg-gray-800 transition-colors font-semibold"
            >
              ZIP 일괄 다운로드 ({checked.size}건)
            </button>
          )}
        </div>

        {/* Disclosure table */}
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-300 gap-2">
            <div className="text-3xl font-bold tracking-widest">DART</div>
            <div>왼쪽에서 회사를 검색하세요</div>
          </div>
        ) : discLoading ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">공시 목록 로딩 중...</div>
        ) : disclosures.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            해당 기간에 조회된 공시가 없습니다
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-gray-50 border-b-2 border-gray-200 z-10">
                <tr>
                  <th className="px-3 py-2 text-left w-8">
                    <input
                      type="checkbox"
                      checked={checked.size === disclosures.length && disclosures.length > 0}
                      onChange={toggleAll}
                      className="cursor-pointer"
                    />
                  </th>
                  <th className="px-3 py-2 text-left text-gray-500 font-semibold w-28">접수일</th>
                  <th className="px-3 py-2 text-left text-gray-500 font-semibold w-16">구분</th>
                  <th className="px-3 py-2 text-left text-gray-500 font-semibold">보고서명</th>
                  <th className="px-3 py-2 text-left text-gray-500 font-semibold w-32">제출인</th>
                  <th className="px-3 py-2 text-left text-gray-500 font-semibold w-10">비고</th>
                  <th className="px-3 py-2 text-right text-gray-500 font-semibold w-40">액션</th>
                </tr>
              </thead>
              <tbody>
                {disclosures.map(d => (
                  <tr
                    key={d.rcept_no}
                    className={`border-b border-gray-100 ${
                      checked.has(d.rcept_no) ? 'bg-gray-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={checked.has(d.rcept_no)}
                        onChange={() => toggleOne(d.rcept_no)}
                        className="cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(d.rcept_dt)}</td>
                    <td className="px-3 py-2 text-gray-400">{CORP_CLS[d.corp_cls] || d.corp_cls}</td>
                    <td className="px-3 py-2 font-medium">{d.report_nm}</td>
                    <td className="px-3 py-2 text-gray-400 truncate max-w-[128px]">{d.flr_nm}</td>
                    <td className="px-3 py-2 text-red-500 font-semibold">{d.rm}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1.5 justify-end">
                        <a
                          href={`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2 py-1 border border-gray-300 hover:border-black text-gray-500 hover:text-black transition-colors whitespace-nowrap"
                        >
                          원문
                        </a>
                        <button
                          onClick={() => downloadZip(d.rcept_no)}
                          disabled={downloading.has(d.rcept_no)}
                          className={`px-2 py-1 border transition-colors whitespace-nowrap ${
                            downloading.has(d.rcept_no)
                              ? 'border-gray-100 text-gray-300 cursor-default'
                              : 'border-gray-300 hover:border-black text-gray-500 hover:text-black'
                          }`}
                        >
                          {downloading.has(d.rcept_no) ? '...' : 'ZIP'}
                        </button>
                        {isAnnualType(d.report_nm) && (
                          <button
                            onClick={() => openFinancial(d.rcept_no, d.report_nm)}
                            className="px-2 py-1 border border-gray-300 hover:border-black text-gray-500 hover:text-black transition-colors whitespace-nowrap"
                          >
                            재무
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-3 py-2 text-gray-400 border-t border-gray-100">
              총 {disclosures.length}건 · {checked.size}건 선택
              {checked.size > 0 && (
                <button
                  onClick={() => setChecked(new Set())}
                  className="ml-3 underline hover:text-black"
                >
                  선택 해제
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Financial Modal */}
      {modal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-8"
          onClick={e => { if (e.target === e.currentTarget) setModal(null) }}
        >
          <div className="bg-white w-full max-w-4xl max-h-[80vh] flex flex-col border border-gray-300 shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 flex-shrink-0">
              <div>
                <div className="font-bold text-sm">{modal.report_nm}</div>
                <div className="text-gray-400 text-[10px] mt-0.5">{modal.rcept_no}</div>
              </div>
              <button
                onClick={() => setModal(null)}
                className="text-gray-400 hover:text-black text-lg leading-none px-2"
              >
                ✕
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-auto p-4">
              {finLoading && (
                <div className="flex items-center justify-center h-32 text-gray-400">
                  재무제표 추출 중...
                </div>
              )}
              {!finLoading && financial && 'error' in financial && (
                <div className="text-red-500">{financial.error}</div>
              )}
              {!finLoading && financial && 'financial_data' in financial && (
                <>
                  <div className="text-[10px] text-gray-400 mb-3">
                    소스: {financial.source_file}
                  </div>
                  <pre className="text-xs whitespace-pre-wrap leading-relaxed font-mono bg-gray-50 p-4 border border-gray-100">
                    {financial.financial_data}
                  </pre>
                </>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex gap-2 px-4 py-3 border-t border-gray-200 flex-shrink-0">
              <a
                href={`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${modal.rcept_no}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 border border-gray-300 hover:border-black text-gray-600 hover:text-black transition-colors"
              >
                DART 원문 열기
              </a>
              <button
                onClick={() => downloadZip(modal.rcept_no)}
                className="px-3 py-1.5 border border-gray-300 hover:border-black text-gray-600 hover:text-black transition-colors"
              >
                ZIP 다운로드
              </button>
              <div className="flex-1" />
              <button
                onClick={() => setModal(null)}
                className="px-3 py-1.5 bg-black text-white hover:bg-gray-800 transition-colors"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
