import { NextRequest, NextResponse } from 'next/server'
import JSZip from 'jszip'

const DART_API_KEY = process.env.DART_API_KEY

function decodeContent(buffer: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (utf8.includes('�')) {
    try { return new TextDecoder('euc-kr').decode(buffer) } catch { return utf8 }
  }
  return utf8
}

function htmlTableToText(xml: string): string {
  const rows = xml.match(/<TR[^>]*>[\s\S]*?<\/TR>/gi) || []
  const lines: string[] = []
  for (const row of rows) {
    const cells = row.match(/<(?:TD|TH)[^>]*>[\s\S]*?<\/(?:TD|TH)>/gi) || []
    const cleaned = cells
      .map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    const hasContent = cleaned.some(t => t.length > 0)
    if (hasContent) lines.push(cleaned.join(' | '))
  }
  return lines.join('\n')
}

const SECTION_MARKERS = [
  '연결재무상태표', '재무상태표', '대차대조표',
  '연결포괄손익계산서', '연결손익계산서', '포괄손익계산서', '손익계산서',
  '연결현금흐름표', '현금흐름표',
  '연 결 재 무 상 태 표', '재 무 상 태 표', '대 차 대 조 표',
  '연 결 포 괄 손 익 계 산 서', '연 결 손 익 계 산 서', '포 괄 손 익 계 산 서', '손 익 계 산 서',
  '연 결 현 금 흐 름 표', '현 금 흐 름 표',
]

function isEmbeddedMarker(text: string, idx: number, marker: string): boolean {
  const normMarker = marker.replace(/\s/g, '')
  const prefix = text.slice(Math.max(0, idx - 16), idx).replace(/\s/g, '')
  if (normMarker === '재무상태표') return prefix.endsWith('연결')
  if (normMarker === '포괄손익계산서') return prefix.endsWith('연결')
  if (normMarker === '손익계산서') return prefix.endsWith('연결') || prefix.endsWith('포괄') || prefix.endsWith('연결포괄')
  if (normMarker === '현금흐름표') return prefix.endsWith('연결')
  return false
}

function findNextSectionIdx(text: string, fromIdx: number, currentNormKey: string): number {
  let minIdx = text.length
  for (const m of SECTION_MARKERS) {
    const nk = m.replace(/\s/g, '')
    if (nk === currentNormKey) continue
    let i = text.indexOf(m, fromIdx)
    while (i !== -1) {
      if (!isEmbeddedMarker(text, i, m)) { if (i < minIdx) minIdx = i; break }
      i = text.indexOf(m, i + 1)
    }
  }
  return minIdx
}

// 섹션 타입별 검증: 추출된 테이블이 해당 재무제표인지 정밀 확인
// 단순 text.includes()로 충분 — 재무제표에만 등장하는 핵심 계정명을 찾는다
function isValidForSection(normKey: string, tbl: string): boolean {
  if (normKey.includes('재무상태표') || normKey.includes('대차대조표')) {
    // BS는 반드시 자산총계·부채총계·자본총계 중 하나를 포함
    return /자산총계|자산합계|부채총계|부채합계|자본총계|자본합계/.test(tbl)
  }
  if (normKey.includes('손익계산서') || normKey.includes('포괄손익계산서')) {
    // IS는 매출액·영업수익·영업이익·당기순이익 중 하나 필수
    // 주석 rollforward 테이블(기초잔액/이자수익/기말잔액)은 이 항목들이 없으므로 자동 제외
    return /매출액|영업수익|순영업수익|영업이익|영업손익|당기순이익|당기순손실/.test(tbl)
  }
  if (normKey.includes('현금흐름표')) {
    return /영업활동|투자활동|재무활동/.test(tbl)
  }
  // 자본변동표 등 기타 섹션: 5행 이상 + 콤마 숫자 조건만 확인
  const rows = tbl.split('\n').filter(l => l.includes('|'))
  return rows.length >= 5 && /\d{3}(?:,\d{3})+/.test(tbl)
}

// 첫 번째 "해당 섹션다운" TABLE 추출 — 중첩 TABLE 깊이 추적
function extractMainTable(html: string, normKey: string): string {
  const TOKEN = /(<TABLE(?:\s[^>]*)?>)|(<\/TABLE\s*>)/gi
  let depth = 0, start = -1
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(html)) !== null) {
    if (m[1]) {
      if (depth === 0) start = m.index
      depth++
    } else if (m[2] && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        const tbl = htmlTableToText(html.slice(start, m.index + m[0].length))
        if (isValidForSection(normKey, tbl)) return tbl
        start = -1
      }
    }
  }
  return ''
}

function extractSections(text: string, seen: Set<string>): string {
  const found: [string, string][] = []

  for (const marker of SECTION_MARKERS) {
    const normKey = marker.replace(/\s/g, '')
    if (seen.has(normKey)) continue

    let idx = 0
    while (true) {
      idx = text.indexOf(marker, idx)
      if (idx === -1) break
      if (isEmbeddedMarker(text, idx, marker)) { idx += marker.length; continue }

      // 현재 마커 ~ 다음 섹션 마커 전까지만 탐색
      const nextIdx = findNextSectionIdx(text, idx + marker.length, normKey)
      const limit = Math.min(nextIdx, idx + 80000)
      const chunk = text.slice(idx, limit)

      const table = extractMainTable(chunk, normKey)
      if (table) {
        seen.add(normKey)
        found.push([normKey, table])
        break
      }
      idx += marker.length  // 이 occurrence에서 못 찾으면 다음 occurrence 시도
    }
  }

  return found.map(([title, t]) => `=== ${title} ===\n${t}`).join('\n\n')
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ rcept_no: string }> }
) {
  const { rcept_no } = await params
  if (!DART_API_KEY) {
    return NextResponse.json({ error: 'DART_API_KEY is not configured' }, { status: 500 })
  }

  const url = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${DART_API_KEY}&rcept_no=${rcept_no}`

  try {
    const res = await fetch(url)
    if (!res.ok) return NextResponse.json({ error: 'DART fetch failed' }, { status: 502 })

    const buffer = await res.arrayBuffer()
    const magic = new Uint8Array(buffer).subarray(0, 2)
    if (magic[0] !== 0x50 || magic[1] !== 0x4b) {
      return NextResponse.json({ error: '유효한 문서가 아닙니다' }, { status: 400 })
    }

    const zip = await JSZip.loadAsync(buffer)
    const xmlFiles = Object.keys(zip.files).filter(n => n.endsWith('.xml'))

    const sorted = [
      ...xmlFiles.filter(n => !n.includes('_')),
      ...xmlFiles.filter(n => n.includes('_')),
    ]

    const seen = new Set<string>()
    const allSections: string[] = []
    const sourceFiles: string[] = []

    for (const fileName of sorted) {
      const fileBuffer = await zip.files[fileName].async('arraybuffer')
      const text = decodeContent(fileBuffer)
      const sections = extractSections(text, seen)
      if (sections) {
        allSections.push(sections)
        sourceFiles.push(fileName)
      }
      const hasBS = seen.has('재무상태표') || seen.has('연결재무상태표') || seen.has('대차대조표')
      const hasIS = seen.has('손익계산서') || seen.has('포괄손익계산서') ||
                    seen.has('연결손익계산서') || seen.has('연결포괄손익계산서')
      const hasCF = seen.has('현금흐름표') || seen.has('연결현금흐름표')
      if (hasBS && hasIS && hasCF) break
    }

    if (allSections.length > 0) {
      return NextResponse.json({
        financial_data: allSections.join('\n\n'),
        source_file: sourceFiles.join(', '),
        rcept_no,
      })
    }

    // fallback
    for (const fileName of sorted) {
      const fileBuffer = await zip.files[fileName].async('arraybuffer')
      const text = decodeContent(fileBuffer)
      const tbl = htmlTableToText(text)
      if (/\d{3}(?:,\d{3})+/.test(tbl)) {
        return NextResponse.json({
          financial_data: `=== 재무제표 (전체 추출) ===\n${tbl}`,
          source_file: fileName,
          rcept_no,
        })
      }
    }

    return NextResponse.json({ error: '재무제표 데이터를 찾을 수 없습니다.' })
  } catch (e) {
    console.error('[financial]', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
