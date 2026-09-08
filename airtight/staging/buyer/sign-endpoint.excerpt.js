// EXCERPT from acquisition-agent src/server/server.js L360-435 (reference only, not standalone-runnable)
 // AIRTIGHT port target: buyer/sign.js. Keep host-lock anti-oracle guard verbatim
        }
        const qa = await answerQuestion(job, payload.question);
        if (qa.error) return send(res, 400, qa);
        return send(res, 200, { job_id: id, ...qa });
      }

      // ── Demo autopilot signer ─────────────────────────────────────────────
      // Signs an x402 payment for OUR OWN /v1/* resource with the funded demo
      // buyer wallet, so browser visitors watch a REAL facilitator-verified,
      // on-chain settlement without installing a wallet. Guarded: real mode
      // only, our resources only (never an open signing oracle).
      if (req.method === 'POST' && url.pathname === '/v1/demo/sign') {
        const cfg = x402Config();
        const key = process.env.DEMO_BUYER_KEY || '';
        if (!key || cfg.mock) {
          return send(res, 501, {
            error: 'demo signer unavailable: needs DEMO_BUYER_KEY + PAYMENT_MODE=x402',
          });
        }
        let payload;
        try {
          payload = JSON.parse((await readBody(req)) || '{}');
        } catch (e) {
          return send(res, 400, { error: `invalid JSON body: ${e.message}` });
        }
        const host = req.headers.host || 'localhost:8787';
        let resource = String(payload.resource || '');
        if (!resource) return send(res, 400, { error: 'resource required' });
        if (!/^https?:\/\//i.test(resource)) resource = `http://${host}${resource}`;
        try {
          const rUrl = new URL(resource);
          // Only ever sign payments for THIS service's resources. Foreign hosts
          // are rejected outright (never normalized) so this endpoint can never
          // become a signing oracle for third-party URLs.
          const reqHost = (req.headers.host || 'localhost:8787').split(':')[0];
          if (rUrl.host.split(':')[0] !== reqHost || !rUrl.pathname.startsWith('/v1/')) {
            return send(res, 400, { error: `resource must be a /v1/ path on ${reqHost}` });
          }
          resource = `http://${req.headers.host}${rUrl.pathname}${rUrl.search}`;
        } catch {
          return send(res, 400, { error: 'unparseable resource URL' });
        }
        const requirements = buildPaymentRequirements(resource);
        const a = requirements.accepts[0];
        const CHAIN_IDS = { base: 8453, 'base-sepolia': 84532 };
        const { signTransferWithAuthorization, deriveAddress } = await import('../payment/signer.mjs');
        const payer = deriveAddress(key);
        const signed = signTransferWithAuthorization({
          privateKey: key,
          from: payer,
          to: a.payTo,
          valueUsdc: Number(a.maxAmountRequired) / 1e6,
          chainId: CHAIN_IDS[a.network] || 84532,
          verifyingContract: a.asset,
          ttlSeconds: Math.min(Number(a.maxTimeoutSeconds) || 300, 600),
          tokenName: a.extra?.name || 'USDC',
          tokenVersion: a.extra?.version || '2',
        });
        const header = Buffer.from(
          JSON.stringify({
            x402Version: 1,
            scheme: 'exact',
            network: a.network,
            resource,
            payload: { authorization: signed.authorization, signature: signed.signature },
          })
        ).toString('base64');
        return send(res, 200, {
          demo: true,
          payer,
          network: a.network,
          amount_usdc: Number(a.maxAmountRequired) / 1e6,
          resource,
          x_payment_header: header,
        });
      }

