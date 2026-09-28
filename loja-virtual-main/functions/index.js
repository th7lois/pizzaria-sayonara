const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { logger } = require('firebase-functions');
const { HttpsError, onCall, onRequest } = require('firebase-functions/v2/https');

initializeApp();

const db = getFirestore();
const secretManager = new SecretManagerServiceClient();
const mercadoPagoApi = 'https://api.mercadopago.com';
const ownerEmail = 'thiegoluiz8@gmail.com';

function secretResource(secretName) {
  return `projects/${process.env.GCLOUD_PROJECT}/secrets/${secretName}`;
}

async function readSecret(secretName) {
  try {
    const [version] = await secretManager.accessSecretVersion({
      name: `${secretResource(secretName)}/versions/latest`
    });
    return version.payload?.data?.toString('utf8') || '';
  } catch (error) {
    if (error.code === 5) return '';
    throw error;
  }
}

function requireOwner(request) {
  if (request.auth?.token.email?.toLowerCase() !== ownerEmail
    || request.auth.token.email_verified !== true) {
    throw new HttpsError('permission-denied', 'Somente a conta proprietária verificada pode alterar esta configuração.');
  }
}

exports.getMercadoPagoSettings = onCall({ region: 'us-central1' }, async request => {
  requireOwner(request);
  const [accessToken, webhookSecret] = await Promise.all([
    readSecret('MP_ACCESS_TOKEN'),
    readSecret('MP_WEBHOOK_SECRET')
  ]);
  return {
    accessTokenConfigured: Boolean(accessToken),
    webhookSecretConfigured: Boolean(webhookSecret),
    environment: accessToken.startsWith('TEST-') ? 'teste' : (accessToken ? 'produção' : null)
  };
});

exports.saveMercadoPagoSettings = onCall({ region: 'us-central1' }, async request => {
  requireOwner(request);
  const accessToken = typeof request.data?.accessToken === 'string' ? request.data.accessToken.trim() : '';
  const webhookSecret = typeof request.data?.webhookSecret === 'string' ? request.data.webhookSecret.trim() : '';
  if (!accessToken && !webhookSecret) {
    throw new HttpsError('invalid-argument', 'Informe pelo menos uma credencial para salvar.');
  }
  if (accessToken && (!/^(TEST-|APP_USR-)[A-Za-z0-9_-]{16,500}$/.test(accessToken))) {
    throw new HttpsError('invalid-argument', 'O Access Token não parece válido.');
  }
  if (webhookSecret && (webhookSecret.length < 16 || webhookSecret.length > 256)) {
    throw new HttpsError('invalid-argument', 'A assinatura secreta do webhook não parece válida.');
  }

  try {
    const updates = [];
    if (accessToken) updates.push(['MP_ACCESS_TOKEN', accessToken]);
    if (webhookSecret) updates.push(['MP_WEBHOOK_SECRET', webhookSecret]);
    await Promise.all(updates.map(([name, value]) => secretManager.addSecretVersion({
      parent: secretResource(name),
      payload: { data: Buffer.from(value, 'utf8') }
    })));
  } catch {
    throw new HttpsError('failed-precondition', 'Não foi possível salvar. Confira a configuração de permissões do Secret Manager.');
  }

  return { saved: true };
});

function getReturnOrigin(request) {
  const requestOrigin = request.rawRequest.get('origin');
  let siteOrigin;
  try {
    siteOrigin = new URL(request.data?.siteOrigin).origin;
  } catch {
    throw new HttpsError('invalid-argument', 'Endereço de retorno inválido.');
  }

  const isLocalDevelopment = siteOrigin.startsWith('http://localhost:')
    || siteOrigin.startsWith('http://127.0.0.1:');
  if (!requestOrigin || siteOrigin !== requestOrigin
    || (!siteOrigin.startsWith('https://') && !isLocalDevelopment)) {
    throw new HttpsError('invalid-argument', 'Endereço de retorno inválido.');
  }
  return siteOrigin;
}

function makeReturnUrl(origin, status, orderId) {
  const url = new URL('/', origin);
  url.searchParams.set('payment', status);
  url.searchParams.set('order', orderId);
  return url.toString();
}

exports.createMercadoPagoPreference = onCall({
  region: 'us-central1'
}, async request => {
  const orderId = request.data?.orderId;
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9]{10,40}$/.test(orderId)) {
    throw new HttpsError('invalid-argument', 'Pedido inválido.');
  }
  const returnOrigin = getReturnOrigin(request);
  const orderRef = db.collection('orders').doc(orderId);
  const orderSnapshot = await orderRef.get();
  if (!orderSnapshot.exists) throw new HttpsError('not-found', 'Pedido não encontrado.');

  const order = orderSnapshot.data();
  const customerUid = order.customer?.userId || null;
  if ((request.auth && customerUid !== request.auth.uid) || (!request.auth && customerUid)) {
    throw new HttpsError('permission-denied', 'Este pedido não pertence a esta sessão.');
  }

  const existingPayment = order.payment;
  if (existingPayment?.provider === 'mercado_pago' && existingPayment.checkoutUrl) {
    return { initPoint: existingPayment.checkoutUrl };
  }

  if (!Array.isArray(order.items) || order.items.length < 1 || order.items.length > 30) {
    throw new HttpsError('failed-precondition', 'O pedido não tem itens válidos.');
  }

  const items = await Promise.all(order.items.map(async item => {
    if (typeof item.id !== 'string' || !Number.isInteger(item.quantity)
      || item.quantity < 1 || item.quantity > 30) {
      throw new HttpsError('failed-precondition', 'O pedido contém um item inválido.');
    }
    const productSnapshot = await db.collection('products').doc(item.id).get();
    if (!productSnapshot.exists) {
      throw new HttpsError('failed-precondition', 'Um produto do pedido não está mais disponível.');
    }
    const product = productSnapshot.data();
    if (typeof product.name !== 'string' || !Number.isFinite(product.price) || product.price <= 0) {
      throw new HttpsError('failed-precondition', 'Um produto do pedido tem dados inválidos.');
    }
    return {
      id: item.id,
      title: product.name,
      quantity: item.quantity,
      unit_price: product.price,
      currency_id: 'BRL'
    };
  }));

  const total = Math.round(items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) * 100) / 100;
  if (total <= 0 || total > 30000) {
    throw new HttpsError('failed-precondition', 'O valor total do pedido é inválido.');
  }

  const preferenceBody = {
    items,
    external_reference: orderId,
    back_urls: {
      success: makeReturnUrl(returnOrigin, 'success', orderId),
      pending: makeReturnUrl(returnOrigin, 'pending', orderId),
      failure: makeReturnUrl(returnOrigin, 'failure', orderId)
    },
    auto_return: 'approved',
    metadata: { order_id: orderId }
  };
  if (request.auth?.token.email) {
    preferenceBody.payer = { email: request.auth.token.email };
  }

  const accessToken = await readSecret('MP_ACCESS_TOKEN');
  if (!accessToken) {
    throw new HttpsError('failed-precondition', 'Configure o Access Token do Mercado Pago no painel do proprietário.');
  }

  let mercadoPagoResponse;
  try {
    mercadoPagoResponse = await fetch(`${mercadoPagoApi}/checkout/preferences`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preferenceBody),
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    logger.error('Falha ao conectar ao Mercado Pago.', error);
    throw new HttpsError('unavailable', 'Não foi possível conectar ao Mercado Pago. Tente novamente.');
  }

  const preference = await mercadoPagoResponse.json().catch(() => ({}));
  if (!mercadoPagoResponse.ok || !preference.id) {
    logger.error('Mercado Pago recusou a criação da preferência.', {
      status: mercadoPagoResponse.status,
      cause: preference.message || preference.error
    });
    throw new HttpsError('failed-precondition', 'O Mercado Pago não conseguiu iniciar o pagamento.');
  }

  const isTestToken = accessToken.startsWith('TEST-');
  const checkoutUrl = isTestToken
    ? (preference.sandbox_init_point || preference.init_point)
    : preference.init_point;
  if (!checkoutUrl) {
    throw new HttpsError('internal', 'O Mercado Pago não retornou o link de pagamento.');
  }

  await orderRef.update({
    items: items.map(item => ({
      id: item.id,
      name: item.title,
      quantity: item.quantity,
      unitPrice: item.unit_price
    })),
    total,
    payment: {
      provider: 'mercado_pago',
      preferenceId: preference.id,
      checkoutUrl,
      status: 'pending',
      updatedAt: new Date().toISOString()
    }
  });

  return { initPoint: checkoutUrl };
});

function verifyWebhookSignature(request, dataId, webhookSecret) {
  const signatureHeader = request.get('x-signature') || '';
  const requestId = request.get('x-request-id') || '';
  const signatureParts = Object.fromEntries(signatureHeader.split(',').map(part => {
    const [key, value] = part.trim().split('=');
    return [key, value];
  }));
  if (!signatureParts.ts || !signatureParts.v1 || !requestId) return false;

  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${signatureParts.ts};`;
  const expected = crypto.createHmac('sha256', webhookSecret)
    .update(manifest)
    .digest();
  let received;
  try {
    received = Buffer.from(signatureParts.v1, 'hex');
  } catch {
    return false;
  }
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

exports.mercadoPagoWebhook = onRequest({
  region: 'us-central1'
}, async (request, response) => {
  if (request.method !== 'POST') {
    response.status(405).send('Method not allowed');
    return;
  }

  const eventType = request.query.type || request.body?.type;
  if (eventType && eventType !== 'payment') {
    response.status(200).send('Ignored');
    return;
  }

  const paymentId = String(request.query['data.id'] || request.body?.data?.id || '');
  let accessToken;
  let webhookSecret;
  try {
    [accessToken, webhookSecret] = await Promise.all([
      readSecret('MP_ACCESS_TOKEN'),
      readSecret('MP_WEBHOOK_SECRET')
    ]);
  } catch {
    response.status(503).send('Secret Manager unavailable');
    return;
  }
  if (!paymentId || !webhookSecret || !verifyWebhookSignature(request, paymentId, webhookSecret)) {
    response.status(401).send('Invalid signature');
    return;
  }

  let mercadoPagoResponse;
  try {
    mercadoPagoResponse = await fetch(`${mercadoPagoApi}/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    logger.error('Falha ao consultar pagamento no Mercado Pago.', error);
    response.status(503).send('Could not verify payment');
    return;
  }

  if (!mercadoPagoResponse.ok) {
    response.status(503).send('Could not verify payment');
    return;
  }
  const payment = await mercadoPagoResponse.json();
  const orderId = payment.external_reference;
  const statusByMercadoPago = {
    approved: 'approved',
    pending: 'pending',
    in_process: 'pending',
    rejected: 'rejected',
    cancelled: 'cancelled',
    refunded: 'refunded',
    charged_back: 'charged_back'
  };
  const paymentStatus = statusByMercadoPago[payment.status];
  if (!orderId || !paymentStatus) {
    response.status(200).send('Ignored');
    return;
  }

  const orderRef = db.collection('orders').doc(orderId);
  await db.runTransaction(async transaction => {
    const orderSnapshot = await transaction.get(orderRef);
    if (!orderSnapshot.exists) return;
    const order = orderSnapshot.data();
    const currentPayment = order.payment || {};
    if (currentPayment.provider !== 'mercado_pago'
      || currentPayment.preferenceId !== payment.preference_id
      || Math.round(Number(order.total) * 100) !== Math.round(Number(payment.transaction_amount) * 100)
      || payment.currency_id !== 'BRL') {
      return;
    }
    if (currentPayment.status === 'approved'
      && !['refunded', 'charged_back'].includes(paymentStatus)) {
      return;
    }
    transaction.update(orderRef, {
      'payment.status': paymentStatus,
      'payment.paymentId': String(payment.id),
      'payment.updatedAt': new Date().toISOString()
    });
  });

  response.status(200).send('OK');
});
