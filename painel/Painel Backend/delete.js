require('dotenv').config();
const mongoose = require('mongoose');

async function limparTodasColecoesAtlas() {
  try {
    // 1) Conecte ao MongoDB Atlas usando sua URI (aguarde a conexão)
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB Atlas conectado!');

    // 2) Obtenha referência ao driver nativo
    const db = mongoose.connection.db;

    // 3) Liste todas as coleções existentes
    const colecoes = await db.listCollections().toArray();

    // 4) Para cada coleção (exceto as de sistema), remova todos os documentos
    for (const { name } of colecoes) {
      if (name.startsWith('system.')) continue;
      await db.collection(name).deleteMany({});
      console.log(`→ Coleção "${name}" limpa.`);
    }

    console.log('Todas as coleções foram limpas com sucesso.');
  } catch (err) {
    console.error('Erro ao limpar coleções:', err);
    process.exit(1);
  } finally {
    // 5) Desconecte ao final (se estiver conectado)
    await mongoose.disconnect();
  }
}

limparTodasColecoesAtlas();
