import { NextRequest, NextResponse } from 'next/server'
import JSZip from 'jszip'

const DART_API_KEY = process.env.DART_API_KEY

function decodeContent(buffer: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (utf8.includes('�')) {
    try {
      return new TextDecoder('euc-kr').decode(buffer)
    } catch {
      return utf8
    }
  }
  return utf8
}

function htmlTableToText(xml: string): string {
  const rows = xml.match(/<TR[^>]*>[\s\S]*?<\/TR>/gi) || []
  const lines: string[] = []
  for (const row of rows) {
    const cells = row.match(/<TD[^>]*>[\s\S]*?<\/TD>/gi) || []
    const cleaned = cells
      .map(c => c.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      .filter(t => t && !/^[.\s-]+$/.test(t))
    if (cleaned.length) lines.push(cleaned.join(' | '))
  }
  return lines.join('\n')
}

function extractSections(text: string): string {
  const markers = [
    '재무상태표', '연결재무상태표',
    '손익계산서', '포괄손익계산서', '연결손익계산서', '연결포괄손익계산서',
    '현금흐름표', '연결현금흐름표',
    // 감사보고서 변형 마커
    '재 무 상 태 표', '연 결 재 무 상 태 표',
    '손 익 계 산 서', '포 괄 손 익 계 산 서',
    '현 금 흐 름 표',
  ]
  const found: [string, string][] = []
  const seen = new Set<string>()

  for (const marker of markers) {
    // 정규화 키 (공백 제거)로 중복 방지
    const normKey = marker.replace(/\s/g, '')
    if (seen.has(normKey)) continue
    let idx = 0
    while (true) {
      idx = text.indexOf(marker, idx)
      if (idx === -1) break
      // 마커 앞뒤로 넓게 탐색 (감사보고서는 테이블이 마커와 멀리 있을 수 있음)
      const chunk = text.slice(Math.max(0, idx - 500), idx + 40000)
      const table = htmlTableToText(chunk)
      if (/\d{3}(?:,\d{3})+/.test(table)) {
        seen.add(normKey)
        found.push([marker.replace(/\s/g, ''), table])
        break
      }
      idx++
    }
  }

  if (found.length === 0) {
    // 마커 탐색 실패 시 문서 전체에서 숫자가 있는 테이블 추출
    const fullTable = htmlTableToText(text)
    if (/\d{3}(?:,\d{3})+/.test(fullTable)) {
      return `=== 재무제표 (전체 추출) ===\n${fullTable}`
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
    const xmlFiles = Object.keys(zip.files)
      .filter(n => n.endsWith('.xml'))
      .sort((a, b) => {
        // 가장 큰 파일(본문)을 먼저
        const sizeA = zip.files[a].comment?.length || 0
        const sizeB = zip.files[b].comment?.length || 0
        return sizeB - sizeA
      })

    // 서브코드 없는 메인 파일을 우선 탐색
    const sorted = [
      ...xmlFiles.filter(n => !n.includes('_')),
      ...xmlFiles.filter(n => n.includes('_')),
    ]

    for (const fileName of sorted) {
      const fileBuffer = await zip.files[fileName].async('arraybuffer')
      const text = decodeContent(fileBuffer)
      const sections = extractSections(text)
      if (sections) {
        return NextResponse.json({ financial_data: sections, source_file: fileName, rcept_no })
      }
    }

    return NextResponse.json({ error: '재무제표 데이터를 찾을 수 없습니다. XBRL 미제출 법인일 수 있습니다.' })
  } catch (e) {
    console.error('[financial]', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
