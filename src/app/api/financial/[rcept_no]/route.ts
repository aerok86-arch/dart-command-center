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
    const cells = row.match(/<TD[^>]*>[\s\S]*?<\/TD>/gi) || []
    const cleaned = cells
      .map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    // 행 전체가 비어있으면 제외, 개별 셀은 빈 문자열 허용 (컬럼 위치 유지)
    const hasContent = cleaned.some(t => t.length > 0)
    if (hasContent) lines.push(cleaned.join(' | '))
  }
  return lines.join('\n')
}

const SECTION_MARKERS = [
  '재무상태표', '연결재무상태표',
  '손익계산서', '포괄손익계산서', '연결손익계산서', '연결포괄손익계산서',
  '현금흐름표', '연결현금흐름표',
  '재 무 상 태 표', '연 결 재 무 상 태 표',
  '손 익 계 산 서', '포 괄 손 익 계 산 서',
  '현 금 흐 름 표',
]

// seen: 이미 추출된 섹션의 정규화 키 집합 (여러 XML 파일에서 공유)
function extractSections(text: string, seen: Set<string>): string {
  const found: [string, string][] = []

  for (const marker of SECTION_MARKERS) {
    const normKey = marker.replace(/\s/g, '')
    if (seen.has(normKey)) continue

    let idx = 0
    while (true) {
      idx = text.indexOf(marker, idx)
      if (idx === -1) break
      // 마커 주변 80KB 탐색 (대형 감사보고서는 마커와 표가 멀리 떨어져 있음)
      const chunk = text.slice(Math.max(0, idx - 1000), idx + 80000)
      const table = htmlTableToText(chunk)
      if (/\d{3}(?:,\d{3})+/.test(table)) {
        seen.add(normKey)
        found.push([normKey, table])
        break
      }
      idx++
    }
  }

  return found.map(([title, t]) => `=== ${title} ===\n${t}`).join('\n\n')
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ rcept_no: string }> }
) {
  const { rcept_no } = await params
  const url = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${DART_API_KEY}&rcept_no=${rcept_no}`

  try {
    const res = await fetch(url)
    if (!res.ok) return NextResponse.json({ error: 'DART fetch failed' }, { status: 502 })

    const buffer = await res.arrayBuffer()
    const magic = new Uint8Array(buffer, 0, 2)
    if (magic[0] !== 0x50 || magic[1] !== 0x4b) {
      return NextResponse.json({ error: '유효한 문서가 아닙니다' }, { status: 400 })
    }

    const zip = await JSZip.loadAsync(buffer)
    const xmlFiles = Object.keys(zip.files).filter(n => n.endsWith('.xml'))

    // 메인 파일(언더스코어 없음) 우선, 그 다음 서브 파일
    const sorted = [
      ...xmlFiles.filter(n => !n.includes('_')),
      ...xmlFiles.filter(n => n.includes('_')),
    ]

    // 여러 XML 파일에서 섹션 누적 (재무상태표/손익계산서가 다른 파일에 있을 수 있음)
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
      // 핵심 3개 섹션 확보하면 중단
      const hasBS = seen.has('재무상태표') || seen.has('연결재무상태표')
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

    // fallback: 문서 전체 테이블 추출
    for (const fileName of sorted) {
      const fileBuffer = await zip.files[fileName].async('arraybuffer')
      const text = decodeContent(fileBuffer)
      const fullTable = htmlTableToText(text)
      if (/\d{3}(?:,\d{3})+/.test(fullTable)) {
        return NextResponse.json({
          financial_data: `=== 재무제표 (전체 추출) ===\n${fullTable}`,
          source_file: fileName,
          rcept_no,
        })
      }
    }

    return NextResponse.json({ error: '재무제표 데이터를 찾을 수 없습니다. XBRL 미제출 법인일 수 있습니다.' })
  } catch (e) {
    console.error('[financial]', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
