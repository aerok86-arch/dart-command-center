import { NextRequest, NextResponse } from 'next/server'

const DART_API_KEY = process.env.DART_API_KEY

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams
  const corp_code = sp.get('corp_code') || ''

  const bgn_de = sp.get('bgn_de') || ''
  const end_de = sp.get('end_de') || ''
  const pblntf_ty = sp.get('pblntf_ty') || ''
  const page_count = sp.get('page_count') || '100'

  const url = new URL('https://opendart.fss.or.kr/api/list.json')
  url.searchParams.set('crtfc_key', DART_API_KEY!)
  if (corp_code) url.searchParams.set('corp_code', corp_code)
  if (bgn_de) url.searchParams.set('bgn_de', bgn_de)
  if (end_de) url.searchParams.set('end_de', end_de)
  if (pblntf_ty) url.searchParams.set('pblntf_ty', pblntf_ty)
  url.searchParams.set('page_count', page_count)

  try {
    const res = await fetch(url.toString())
    const data = await res.json()
    return NextResponse.json(data)
  } catch (e) {
    console.error('[disclosures]', e)
    return NextResponse.json({ error: 'Failed to fetch disclosures' }, { status: 502 })
  }
}
