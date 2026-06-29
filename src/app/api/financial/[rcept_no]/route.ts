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
    // DART 감사보고서 XML은 데이터 셀에 <TE> 태그 사용 (비표준) — TD/TH/TE 모두 처리
    const cells = row.match(/<(?:TD|TH|TE)[^>]*>[\s\S]*?<\/(?:TD|TH|TE)>/gi) || []
    const cleaned = cells
      .map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    const hasContent = cleaned.some(t => t.length > 0)
    if (hasContent) lines.push(cleaned.join(' | '))
  }
  return lines.join('\n')
}

type FoundTables = { bs?: string; is?: string; cf?: string }

// 문서 전체 TABLE을 스캔해 재무상태표/손익계산서/현금흐름표를 타입별로 첫 발견 수집
// DART 비상장 감사보고서는 TOC에만 섹션 마커가 있고 실제 테이블 앞에는 마커가 없음
// → 마커 기반 섹션 분리 대신 테이블 타입별 분류 사용
function scanFinancialTables(text: string): FoundTables {
  const found: FoundTables = {}

  const TOKEN = /(<TABLE(?:\s[^>]*)?>)|(<\/TABLE\s*>)/gi
  let depth = 0, start = -1
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(text)) !== null) {
    if (m[1]) {
      if (depth === 0) start = m.index
      depth++
    } else if (m[2] && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        const tbl = htmlTableToText(text.slice(start, m.index + m[0].length))
        const c = tbl.replace(/\s/g, '')  // 공백 제거로 "자 산 총 계" = "자산총계" 처리

        // BS: 자산총계·부채총계·자본총계 중 하나
        if (!found.bs && /자산총계|자산합계|부채총계|부채합계|자본총계|자본합계/.test(c)) {
          found.bs = tbl
        }
        // IS: 매출액·영업이익 등 IS 고유 계정 (이익잉여금처분계산서의 당기순이익은 제외)
        if (!found.is && /매출액|영업수익|순영업수익|이자수익합계|영업이익|영업손익|영업손실/.test(c)) {
          found.is = tbl
        }
        // CF: 영업/투자/재무활동
        if (!found.cf && /영업활동|투자활동|재무활동/.test(c)) {
          found.cf = tbl
        }

        start = -1
        if (found.bs && found.is && found.cf) break
      }
    }
  }

  return found
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

    const global: FoundTables = {}
    const sourceFiles: string[] = []
    let isConsolidated = false

    for (const fileName of sorted) {
      const fileBuffer = await zip.files[fileName].async('arraybuffer')
      const text = decodeContent(fileBuffer)

      // 연결 여부 감지
      if (!isConsolidated && (text.includes('연결재무상태표') || text.includes('연결손익계산서'))) {
        isConsolidated = true
      }

      const found = scanFinancialTables(text)
      let contributed = false
      if (!global.bs && found.bs) { global.bs = found.bs; contributed = true }
      if (!global.is && found.is) { global.is = found.is; contributed = true }
      if (!global.cf && found.cf) { global.cf = found.cf; contributed = true }
      if (contributed) sourceFiles.push(fileName)

      if (global.bs && global.is && global.cf) break
    }

    const sections: string[] = []
    const pfx = isConsolidated ? '연결' : ''
    if (global.bs) sections.push(`=== ${pfx}재무상태표 ===\n${global.bs}`)
    if (global.is) sections.push(`=== ${pfx}손익계산서 ===\n${global.is}`)
    if (global.cf) sections.push(`=== ${pfx}현금흐름표 ===\n${global.cf}`)

    if (sections.length > 0) {
      return NextResponse.json({
        financial_data: sections.join('\n\n'),
        source_file: sourceFiles.join(', '),
        rcept_no,
      })
    }

    // fallback: 숫자 콤마가 있는 파일이면 전체 텍스트 추출
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
