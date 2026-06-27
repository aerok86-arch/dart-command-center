import { NextRequest, NextResponse } from 'next/server'

const DART_API_KEY = process.env.DART_API_KEY

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
      return NextResponse.json({ error: '유효한 문서 ZIP이 아닙니다' }, { status: 400 })
    }

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${rcept_no}.zip"`,
      },
    })
  } catch (e) {
    console.error('[document]', e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
