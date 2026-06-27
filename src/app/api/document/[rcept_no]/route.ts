import { NextRequest, NextResponse } from 'next/server'

const DART_API_KEY = process.env.DART_API_KEY

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
