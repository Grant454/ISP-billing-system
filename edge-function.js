// ══════════════════════════════════════════════════════════════════════
//  NetBill Pro — Supabase Edge Function
//
//  This is your "backend". Deploy it to Supabase Edge Functions.
//  It handles:
//    1. POST /mpesa-callback   → M-Pesa payment confirmation
//    2. POST /stk-push         → Initiate STK Push from portal
//    3. POST /connect-ip       → Manually connect an IP (admin)
//    4. POST /disconnect-ip    → Manually disconnect an IP (admin)
//    5. POST /redeem-voucher   → Redeem a voucher code from portal
//    6. GET  /session-status   → Poll session status from portal
//    7. POST /cron-disconnect  → Called every minute to expire sessions
//
//  DEPLOY STEPS:
//  1. Install Supabase CLI:  npm install -g supabase
//  2. Login:                 supabase login
//  3. Link project:          supabase link --project-ref YOUR_PROJECT_REF
//  4. Create function:       supabase functions new netbill
//  5. Replace index.ts with this file (rename to index.ts)
//  6. Set secrets:
//       supabase secrets set MT_IP=192.168.88.1
//       supabase secrets set MT_PORT=80
//       supabase secrets set MT_USER=admin
//       supabase secrets set MT_PASS=yourpassword
//       supabase secrets set MP_ENV=sandbox
//       supabase secrets set MP_KEY=your_consumer_key
//       supabase secrets set MP_SECRET=your_consumer_secret
//       supabase secrets set MP_SHORTCODE=174379
//       supabase secrets set MP_PASSKEY=your_passkey
//       supabase secrets set MP_CALLBACK_URL=https://YOUR_PROJECT.supabase.co/functions/v1/netbill/mpesa-callback
//       supabase secrets set AT_USERNAME=sandbox
//       supabase secrets set AT_KEY=your_at_api_key
//       supabase secrets set AT_SENDER=NETBILL
//       supabase secrets set ISP_NAME=Jamii Fibre
//       supabase secrets set ISP_PAYBILL=247247
//  7. Deploy:                supabase functions deploy netbill
//
//  Your function URL will be:
//  https://YOUR_PROJECT_REF.supabase.co/functions/v1/netbill
// ══════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

// ── Supabase client (service_role bypasses RLS) ──────────────────────
const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// ════════════════════════════════════════════════════════════════════
//  MIKROTIK REST API
// ════════════════════════════════════════════════════════════════════
const MT = {
  base: () => `http://${Deno.env.get('MT_IP')}:${Deno.env.get('MT_PORT') || 80}/rest`,
  headers: () => {
    const cred = btoa(`${Deno.env.get('MT_USER')}:${Deno.env.get('MT_PASS')}`)
    return { Authorization: `Basic ${cred}`, 'Content-Type': 'application/json' }
  },

  async call(path: string, method = 'GET', body?: object) {
    const res = await fetch(`${MT.base()}/${path}`, {
      method,
      headers: MT.headers(),
      body: body ? JSON.stringify(body) : undefined,
    })
    const txt = await res.text()
    if (!res.ok) throw new Error(`MikroTik ${res.status}: ${txt.slice(0, 200)}`)
    return txt ? JSON.parse(txt) : null
  },

  // Add IP to firewall address-list with a timeout → auto-removed when time expires
  // MikroTik natively removes the entry when timeout expires = automatic disconnect
  async connectIP(ip: string, timeoutStr: string, comment: string) {
    // Remove existing entry first (handles renewals)
    await MT.disconnectIP(ip).catch(() => {})
    return MT.call('ip/firewall/address-list', 'PUT', {
      list: 'netbill-active',
      address: ip,
      timeout: timeoutStr,   // e.g. "02:00:00"  or  "1d00:00:00"
      comment,
    })
  },

  // Force remove IP from address-list
  async disconnectIP(ip: string) {
    const entries = await MT.call(
      `ip/firewall/address-list?list=netbill-active&address=${ip}`
    ).catch(() => []) as any[]
    for (const e of entries || []) {
      await MT.call(`ip/firewall/address-list/${e['.id']}`, 'DELETE').catch(() => {})
    }
  },

  // Simple Queue for bandwidth shaping
  async addQueue(name: string, ip: string, dl: number, ul: number) {
    await MT.removeQueue(name).catch(() => {})
    return MT.call('queue/simple', 'PUT', {
      name,
      target: `${ip}/32`,
      'max-limit': `${ul}M/${dl}M`,
      comment: 'NetBill managed',
    })
  },

  async removeQueue(name: string) {
    const list = await MT.call(`queue/simple?name=${encodeURIComponent(name)}`).catch(() => []) as any[]
    for (const q of list || []) {
      await MT.call(`queue/simple/${q['.id']}`, 'DELETE').catch(() => {})
    }
  },

  async ping() { return MT.call('system/identity') },
}

// ════════════════════════════════════════════════════════════════════
//  M-PESA DARAJA
// ════════════════════════════════════════════════════════════════════
const MPesa = {
  apiBase: () => Deno.env.get('MP_ENV') === 'live'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke',

  async getToken() {
    const cred = btoa(`${Deno.env.get('MP_KEY')}:${Deno.env.get('MP_SECRET')}`)
    const res = await fetch(`${MPesa.apiBase()}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${cred}` },
    })
    const d = await res.json()
    if (!d.access_token) throw new Error('M-Pesa auth failed')
    return d.access_token
  },

  async stkPush(phone: string, amount: number, accountRef: string, sessionId: string) {
    const token = await MPesa.getToken()
    const sc = Deno.env.get('MP_SHORTCODE')!
    const pk = Deno.env.get('MP_PASSKEY')!
    const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    const password = btoa(`${sc}${pk}${ts}`)
    const pn = phone.replace(/\D/g, '').replace(/^0/, '254').replace(/^254254/, '254')

    const res = await fetch(`${MPesa.apiBase()}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: sc,
        Password: password,
        Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.ceil(amount),
        PartyA: pn,
        PartyB: sc,
        PhoneNumber: pn,
        CallBackURL: Deno.env.get('MP_CALLBACK_URL'),
        AccountReference: accountRef,
        TransactionDesc: `Internet - ${accountRef}`,
      }),
    })
    return res.json()
  },
}

// ════════════════════════════════════════════════════════════════════
//  SMS — AFRICA'S TALKING
// ════════════════════════════════════════════════════════════════════
async function sendSMS(phone: string, message: string) {
  const user = Deno.env.get('AT_USERNAME')
  const key  = Deno.env.get('AT_KEY')
  if (!user || !key) return null

  const base = user === 'sandbox'
    ? 'https://api.sandbox.africastalking.com'
    : 'https://api.africastalking.com'

  const body = new URLSearchParams({ username: user, to: phone, message })
  const sender = Deno.env.get('AT_SENDER')
  if (sender) body.set('from', sender)

  return fetch(`${base}/version1/messaging`, {
    method: 'POST',
    headers: { apiKey: key, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }).catch(() => null)
}

// ════════════════════════════════════════════════════════════════════
//  CORE: CONNECT A SESSION
// ════════════════════════════════════════════════════════════════════
async function connectSession(sessionId: string, receipt: string) {
  const { data: session } = await sb.from('sessions').select('*, plans(*)').eq('id', sessionId).single()
  if (!session) throw new Error('Session not found')
  if (session.status === 'active') return { ok: true, msg: 'Already active' }

  const ip = session.ip_address
  const hours = session.duration_hours
  const plan = session.plans || {}

  // Format MikroTik timeout: "HH:MM:SS" for <24h, "Xd HH:MM:SS" for ≥24h
  const totalSec = Math.round(hours * 3600)
  const days = Math.floor(totalSec / 86400)
  const rem  = totalSec % 86400
  const hh   = String(Math.floor(rem / 3600)).padStart(2, '0')
  const mm   = String(Math.floor((rem % 3600) / 60)).padStart(2, '0')
  const ss   = String(rem % 60).padStart(2, '0')
  const timeoutStr = days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`

  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString()
  const queueName = `nb_${ip.replace(/\./g, '_')}`
  const comment   = `${session.customer_name} | ${session.plan_name} | exp:${new Date(expiresAt).toLocaleString()}`

  // ── MikroTik: add to firewall list (auto-disconnects when timeout expires)
  await MT.connectIP(ip, timeoutStr, comment)

  // ── MikroTik: bandwidth queue
  if (plan.speed_down_mbps && plan.speed_up_mbps) {
    await MT.addQueue(queueName, ip, plan.speed_down_mbps, plan.speed_up_mbps).catch(() => {})
  }

  // ── Update session in Supabase
  await sb.from('sessions').update({
    status: 'active',
    mpesa_receipt: receipt,
    connected_at: new Date().toISOString(),
    expires_at: expiresAt,
    mt_queue_name: queueName,
  }).eq('id', sessionId)

  // ── Send SMS confirmation
  const isp  = Deno.env.get('ISP_NAME') || 'Your ISP'
  const pb   = Deno.env.get('ISP_PAYBILL') || ''
  const expStr = new Date(expiresAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })
  const msg = `${isp}: Connected! ${session.plan_name} expires ${expStr}. Enjoy your internet! Paybill: ${pb}`
  await sendSMS(session.customer_phone, msg)

  return { ok: true, ip, expiresAt, plan: session.plan_name }
}

// ════════════════════════════════════════════════════════════════════
//  CORE: DISCONNECT A SESSION
// ════════════════════════════════════════════════════════════════════
async function disconnectSession(sessionId: string) {
  const { data: session } = await sb.from('sessions').select('*').eq('id', sessionId).single()
  if (!session) throw new Error('Session not found')

  await MT.disconnectIP(session.ip_address).catch(() => {})
  if (session.mt_queue_name) await MT.removeQueue(session.mt_queue_name).catch(() => {})

  await sb.from('sessions').update({
    status: 'disconnected',
    disconnected_at: new Date().toISOString(),
  }).eq('id', sessionId)

  return { ok: true }
}

// ════════════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ════════════════════════════════════════════════════════════════════
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const url = new URL(req.url)
  const path = url.pathname.split('/').pop()
  const json = (data: object, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  try {
    // ── 1. M-PESA CALLBACK ─────────────────────────────────────
    if (path === 'mpesa-callback' && req.method === 'POST') {
      const body = await req.json()
      const cb   = body.Body?.stkCallback
      if (!cb) return json({ ok: true })

      const checkoutId = cb.CheckoutRequestID
      const resultCode = cb.ResultCode
      const receipt    = cb.CallbackMetadata?.Item?.find((i: any) => i.Name === 'MpesaReceiptNumber')?.Value || ''

      // Log payment
      await sb.from('payments').insert({
        checkout_request_id: checkoutId,
        result_code: resultCode,
        result_desc: cb.ResultDesc,
        mpesa_receipt: receipt,
      })

      if (resultCode === 0) {
        // Payment success — find session and connect
        const { data: session } = await sb.from('sessions')
          .select('id, amount_ksh, customer_phone')
          .eq('checkout_request_id', checkoutId)
          .single()

        if (session) {
          await sb.from('payments').update({ session_id: session.id, amount_ksh: session.amount_ksh, phone: session.customer_phone }).eq('checkout_request_id', checkoutId)
          await connectSession(session.id, receipt)
        }
      } else {
        // Payment failed — update session
        await sb.from('sessions')
          .update({ status: 'failed' })
          .eq('checkout_request_id', checkoutId)
      }

      return json({ ResultCode: 0, ResultDesc: 'Accepted' })
    }

    // ── 2. INITIATE STK PUSH ───────────────────────────────────
    if (path === 'stk-push' && req.method === 'POST') {
      const { phone, plan_id, ip_address, customer_name } = await req.json()
      if (!phone || !plan_id || !ip_address) return json({ error: 'phone, plan_id and ip_address required' }, 400)

      // Get plan
      const { data: plan } = await sb.from('plans').select('*').eq('id', plan_id).single()
      if (!plan) return json({ error: 'Plan not found' }, 404)

      // Upsert customer
      let customer: any
      const { data: existing } = await sb.from('customers').select('id').eq('phone', phone).single()
      if (existing) {
        await sb.from('customers').update({ name: customer_name, ip_address }).eq('phone', phone)
        customer = existing
      } else {
        const { data: created } = await sb.from('customers').insert({ name: customer_name || 'Customer', phone, ip_address }).select().single()
        customer = created
      }

      // Disconnect any existing active session for this IP
      const { data: oldSessions } = await sb.from('sessions').select('id').eq('ip_address', ip_address).eq('status', 'active')
      for (const s of oldSessions || []) await disconnectSession(s.id).catch(() => {})

      // Create pending session
      const { data: session } = await sb.from('sessions').insert({
        customer_id: customer.id,
        customer_name: customer_name || 'Customer',
        customer_phone: phone,
        ip_address,
        plan_id: plan.id,
        plan_name: plan.name,
        duration_hours: plan.duration_hours,
        amount_ksh: plan.price_ksh,
        status: 'pending',
      }).select().single()

      if (!session) return json({ error: 'Failed to create session' }, 500)

      // Initiate STK Push
      const stkResult = await MPesa.stkPush(phone, plan.price_ksh, `NET-${session.id.slice(0, 8).toUpperCase()}`, session.id)

      if (stkResult.ResponseCode === '0') {
        await sb.from('sessions').update({ checkout_request_id: stkResult.CheckoutRequestID }).eq('id', session.id)
        return json({ ok: true, session_id: session.id, checkout_request_id: stkResult.CheckoutRequestID, message: `STK Push sent to ${phone}` })
      } else {
        await sb.from('sessions').update({ status: 'failed' }).eq('id', session.id)
        return json({ error: stkResult.errorMessage || stkResult.CustomerMessage || 'STK Push failed' }, 400)
      }
    }

    // ── 3. CONNECT IP (admin manual) ───────────────────────────
    if (path === 'connect-ip' && req.method === 'POST') {
      const { session_id } = await req.json()
      const result = await connectSession(session_id, 'MANUAL')
      return json(result)
    }

    // ── 4. DISCONNECT IP (admin manual) ────────────────────────
    if (path === 'disconnect-ip' && req.method === 'POST') {
      const { session_id } = await req.json()
      const result = await disconnectSession(session_id)
      return json(result)
    }

    // ── 5. REDEEM VOUCHER ──────────────────────────────────────
    if (path === 'redeem-voucher' && req.method === 'POST') {
      const { code, ip_address, phone, customer_name } = await req.json()
      if (!code || !ip_address) return json({ error: 'code and ip_address required' }, 400)

      const { data: voucher } = await sb.from('vouchers').select('*, plans(*)').eq('code', code.toUpperCase().trim()).single()
      if (!voucher) return json({ error: 'Invalid voucher code' }, 404)
      if (!voucher.is_active) return json({ error: 'Voucher is no longer active' }, 400)
      if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) return json({ error: 'Voucher has expired' }, 400)
      if (voucher.uses >= voucher.max_uses) return json({ error: 'Voucher has already been fully used' }, 400)

      const plan = voucher.plans

      // Upsert customer
      let customer: any
      if (phone) {
        const { data: ex } = await sb.from('customers').select('id').eq('phone', phone).single()
        if (ex) { await sb.from('customers').update({ ip_address }).eq('phone', phone); customer = ex }
        else { const { data: c } = await sb.from('customers').insert({ name: customer_name || 'Customer', phone, ip_address }).select().single(); customer = c }
      }

      // Disconnect existing session on this IP
      const { data: old } = await sb.from('sessions').select('id').eq('ip_address', ip_address).eq('status', 'active')
      for (const s of old || []) await disconnectSession(s.id).catch(() => {})

      // Create session
      const { data: session } = await sb.from('sessions').insert({
        customer_id: customer?.id || null,
        customer_name: customer_name || 'Voucher User',
        customer_phone: phone || 'N/A',
        ip_address,
        plan_id: plan?.id || null,
        plan_name: plan?.name || voucher.plan_name,
        duration_hours: voucher.duration_hours,
        amount_ksh: voucher.price_ksh,
        status: 'pending',
      }).select().single()

      // Mark voucher used
      await sb.from('vouchers').update({ uses: voucher.uses + 1 }).eq('id', voucher.id)
      await sb.from('voucher_redemptions').insert({ voucher_id: voucher.id, session_id: session.id, ip_address })

      // Connect immediately
      const result = await connectSession(session.id, `VOUCHER-${code}`)
      return json({ ok: true, ...result })
    }

    // ── 6. SESSION STATUS (portal polling) ─────────────────────
    if (path === 'session-status' && req.method === 'GET') {
      const sessionId = url.searchParams.get('id')
      const ip        = url.searchParams.get('ip')

      let query = sb.from('sessions').select('id,status,plan_name,connected_at,expires_at,ip_address,customer_name,amount_ksh')
      if (sessionId) query = query.eq('id', sessionId)
      else if (ip)   query = query.eq('ip_address', ip).order('created_at', { ascending: false }).limit(1)

      const { data } = await query.single()
      return json(data || { status: 'none' })
    }

    // ── 7. CRON DISCONNECT (call every minute from admin or external cron) ──
    if (path === 'cron-disconnect' && req.method === 'POST') {
      const { data: expired } = await sb.from('sessions')
        .select('id, ip_address, mt_queue_name, customer_phone, plan_name, customer_name')
        .eq('status', 'active')
        .lt('expires_at', new Date().toISOString())

      let count = 0
      for (const s of expired || []) {
        try {
          await MT.disconnectIP(s.ip_address)
          if (s.mt_queue_name) await MT.removeQueue(s.mt_queue_name).catch(() => {})
          await sb.from('sessions').update({ status: 'expired', disconnected_at: new Date().toISOString() }).eq('id', s.id)
          // SMS notification
          if (s.customer_phone && s.customer_phone !== 'N/A') {
            const isp = Deno.env.get('ISP_NAME') || 'Your ISP'
            const pb  = Deno.env.get('ISP_PAYBILL') || ''
            await sendSMS(s.customer_phone, `${isp}: Your ${s.plan_name} session has expired. Reconnect at ${pb} or our portal. Thank you!`)
          }
          count++
        } catch (e) { console.error('Disconnect error:', e) }
      }

      return json({ ok: true, disconnected: count })
    }

    // ── 8. PING / TEST ─────────────────────────────────────────
    if (path === 'ping' && req.method === 'GET') {
      const mt = await MT.ping().catch(e => ({ error: e.message }))
      return json({ ok: true, mikrotik: mt })
    }

    return json({ error: 'Not found' }, 404)

  } catch (e: any) {
    console.error(e)
    return json({ error: e.message }, 500)
  }
})
