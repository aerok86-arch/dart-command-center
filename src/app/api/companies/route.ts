import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

type CompactCo = { c: string; n: string; e: string; s: string }

type Company = {
  corp_code: string
  corp_name: string
  corp_eng_name: string
  stock_code: string | null
}

// Module-level cache: warm instances reuse this
let cache: CompactCo[] | null = null

function getList(): CompactCo[] {
  if (cache) return cache
  const raw = fs.readFileSync(path.join(process.cwd(), 'data', 'companies.json'), 'utf-8')
  cache = JSON.parse(raw)
  return cache!
}

export function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim() || ''
  if (!q) return NextResponse.json([])

  try {
    const list = getList()
    const ql = q.toLowerCase()

    const results: Company[] = list
      .filter(c => c.n.includes(q) || c.e.toLowerCase().includes(ql) || (c.s && c.s.includes(q)))
      .sort((a, b) => {
        const rank = (co: CompactCo) =>
          co.n === q ? 0 : co.n.startsWith(q) ? 1 : 2
        const dr = rank(a) - rank(b)
        if (dr !== 0) return dr
        return a.n.length - b.n.length
      })
      .slice(0, 30)
      .map(c => ({
        corp_code: c.c,
        corp_name: c.n,
        corp_eng_name: c.e,
        stock_code: c.s || null,
      }))

    return NextResponse.json(results)
  } catch (e) {
    console.error('[companies]', e)
    return NextResponse.json([])
  }
}
