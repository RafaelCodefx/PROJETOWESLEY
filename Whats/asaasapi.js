//asaasapi.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const jwt = require('jsonwebtoken');
require('dotenv').config();
const app = express();
const PORT = 3333; 


const headers = {
  'access_token': TOKEN
};

// Função para buscar dados do Asaas
async function fetchAsaas(endpoint, params = {}) {
  const url = 'https://www.asaas.com/api/v3/' + endpoint;
  const { data } = await axios.get(url, { params, headers });
  return data;
}

// Habilite CORS para acesso do frontend
app.use(cors());

function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ ok: false, msg: 'Token não fornecido.' });
  const [, token] = authHeader.split(' ');
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, msg: 'Token inválido ou expirado.' });
  }
}


// Rota principal do painel (resumo geral)
app.get('/api/painel', auth,  async (req, res) => {
  try {
    // Busque os dados paralelamente
    const [customers, payments, paymentsReceived, paymentsPending, paymentsOverdue] = await Promise.all([
      fetchAsaas('customers'),
      fetchAsaas('payments'),
      fetchAsaas('payments', { status: 'RECEIVED' }),
      fetchAsaas('payments', { status: 'PENDING' }),
      fetchAsaas('payments', { status: 'OVERDUE' }),
    ]);

    const totalRecebido = paymentsReceived.data.reduce((sum, item) => sum + item.value, 0);
    const totalPending = paymentsPending.data.reduce((sum, item) => sum + item.value, 0);
    const totalOverdue = paymentsOverdue.data.reduce((sum, item) => sum + item.value, 0);

    res.json({
      totalClientes: customers.totalCount,
      totalCobrancas: payments.totalCount,
      totalRecebido,
      totalPendente: totalPending,
      totalVencido: totalOverdue,
      ultimosClientes: customers.data.slice(0, 5),
      ultimasCobrancas: payments.data.slice(0, 5)
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar dados do Asaas', detalhes: err?.response?.data || err.message });
  }
});

// Você pode criar rotas individuais para cada info, se preferir

app.listen(PORT, () => {
  console.log(`API do Painel Asaas rodando em http://192.168.1.11:${PORT}/api/painel`);
});
