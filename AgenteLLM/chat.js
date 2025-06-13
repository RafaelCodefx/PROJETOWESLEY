import express from "express";
import jwt from "jsonwebtoken";
import axios from "axios";
import cors from "cors";

import dotenv from "dotenv";
import { ChatOpenAI } from "@langchain/openai";


import { HumanMessage, SystemMessage } from "langchain/schema";




dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());


const chat = new ChatOpenAI({
  temperature: 0.3,
  modelName: "gpt-4",
  openAIApiKey: process.env.OPENAI_API_KEY
});

// Consulta histórico no backend com base no nome
async function buscarDadosPorNome(nomeCliente, jwtToken) {
    try {
      const res = await axios.get(
        `http://localhost:3001/api/memoria/resumo-por-nome/${encodeURIComponent(nomeCliente)}`,
        {
          headers: {
            Authorization: jwtToken
          }
        }
      );
      return res.data;
    } catch (err) {
      console.error("Erro ao buscar dados:", err.response?.data || err.message);
      return null;
    }
   
  }
  
  

app.post("/api/webhook", async (req, res) => {
    const pergunta = req.body.question;
    const jwtToken = req.headers.authorization;
  
    if (!pergunta) {
      return res.status(400).json({ answer: "❌ Pergunta ausente." });
    }
  
    try {
      const intentPrompt = `
  Sua tarefa é identificar se a seguinte pergunta está pedindo um resumo das interações de um cliente.
  - Se estiver, responda com exatamente: RESUMO: <nome do cliente>
  - Se não for um pedido de resumo, responda apenas com OUTRA.
  
  Pergunta: """${pergunta}"""
  `;
  
      const intentResp = await chat.call([new SystemMessage(intentPrompt)]);
      const resultado = intentResp.text.trim();
      console.log("🔍 Intenção detectada:", resultado);
  
      if (!resultado.startsWith("RESUMO:")) {
        return res.json({ answer: "❌ No momento, só posso gerar resumos. Ainda estou aprendendo usar novas funções aqui." });
      }
  
      const nomeCliente = resultado.replace("RESUMO:", "").trim();
  
      const dados = await buscarDadosPorNome(nomeCliente, jwtToken); // ← AQUI o token dinâmico
      if (!dados || !dados.history) {
        return res.json({ answer: `❌ Histórico não encontrado para ${nomeCliente}.` });
      }
  
      const historicoFormatado = dados.history.map(entry =>
        `${entry.from === "user" ? "Cliente" : "Bot"}: ${entry.text}`
      ).join("\n");
  
      const resumoPrompt = `
  Você é um assistente que deve gerar um resumo claro e profissional das interações com o cliente abaixo:
  
  Nome do cliente: ${nomeCliente}
  
  Histórico:
  ${historicoFormatado}
  `;
  
      const resposta = await chat.call([new SystemMessage(resumoPrompt)]);
  
      return res.json({ answer: resposta.text });
  
    } catch (err) {
      console.error("💥 ERRO:", err);
      return res.status(500).json({ answer: "❌ Erro ao processar a solicitação." });
    }
  });
  
  


const PORT = process.env.PORT || 8003;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
