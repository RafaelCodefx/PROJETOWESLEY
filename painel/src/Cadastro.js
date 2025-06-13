import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import logo_supernova from './assets/logo_supernova.jpeg';
import { motion } from 'framer-motion';
import 'bootstrap/dist/css/bootstrap.min.css';

function useMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 480);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 480);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return isMobile;
}

function Cadastro() {
  const [email, setEmail] = useState('');
  const [nome, setNome] = useState('');
  const [senha, setSenha] = useState('');
  const [confirmsenha, setconfirmsenha] = useState('');
  const [msg, setMsg] = useState('');
  const [numero, setNumero] = useState('');
  const navigate = useNavigate();
  const isMobile = useMobile();

  const handleChange = (e) => {
    const input = e.target.value.replace(/\D/g, '');
    if (input.length <= 13) setNumero(input);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (senha !== confirmsenha) {
      setMsg('As senhas não conferem!');
      return;
    }
    if (!numero || !email || !senha || !confirmsenha || !nome) {
      setMsg('Existem dados não preenchidos.');
      return;
    }
    if (!/^\d{12}$/.test(numero)) {
      setMsg('O número deve conter exatamente 12 dígitos no formato: 556699738750');
      return;
    }

    try {
      const res = await fetch('http://localhost:3001/api/cadastro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome, numero, email, senha })
      });

      const data = await res.json();
      if (data.erros) setMsg(data.erros[0].msg);
      else setMsg(data.msg);

      if (data.ok) {
        setEmail('');
        setNome('');
        setSenha('');
        setconfirmsenha('');
        setNumero('');
        setTimeout(() => navigate('/'), 1000);
      }
    } catch (err) {
      setMsg('Erro ao cadastrar!');
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1 }}
      className="min-vh-100 d-flex align-items-center justify-content-center bg-light"
      style={{ background: 'linear-gradient(to right, #f7f9fc, #dfe9f3)' }}
    >
      <motion.form
        onSubmit={handleSubmit}
        initial={{ y: -50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 100 }}
        className="bg-white p-4 rounded-4 shadow-lg"
        style={{ maxWidth: 420, width: '100%' }}
      >
        <motion.div
          className={`d-flex ${isMobile ? 'justify-content-center' : 'justify-content-start'} mb-3`}
          initial={{ scale: 0.9 }}
          animate={{ scale: 1 }}
        >
          <motion.img
            src={logo_supernova}
            alt="Logo"
            className="rounded-3"
            style={{ width: isMobile ? 90 : 150 }}
            whileHover={{ scale: 1.05 }}
          />
        </motion.div>

        <motion.div
          className="mb-3 text-secondary small"
          style={{ fontFamily: 'Roboto' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          <p className="mb-1">🌟 Vamos Juntos Criar Sua Conta!</p>
          <p className="mb-0">Por favor, preencha o formulário abaixo:</p>
        </motion.div>

        <h2 className="text-primary text-center mb-4 fs-4 fw-semibold">Criar conta</h2>

        <input
          type="text"
          className="form-control mb-3"
          placeholder="Seu nome"
          value={nome}
          onChange={e => setNome(e.target.value)}
          required
        />

        <input
          type="text"
          className="form-control mb-3"
          placeholder="Número de WhatsApp"
          value={numero}
          onChange={handleChange}
          required
        />

        <input
          type="email"
          className="form-control mb-3"
          placeholder="Seu e-mail"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />

        <input
          type="password"
          className="form-control mb-3"
          placeholder="Senha"
          value={senha}
          onChange={e => setSenha(e.target.value)}
          required
        />

        <input
          type="password"
          className="form-control mb-4"
          placeholder="Confirmar Senha"
          value={confirmsenha}
          onChange={e => setconfirmsenha(e.target.value)}
          required
        />

        <motion.button
          whileTap={{ scale: 0.98 }}
          whileHover={{ backgroundColor: '#218838' }}
          transition={{ duration: 0.2 }}
          type="submit"
          className="btn btn-success w-100 fw-bold mb-3"
        >
          Cadastrar
        </motion.button>

        {msg && (
          <motion.div
            className={`text-center mb-3 fw-medium ${msg.includes('sucesso') ? 'text-success' : 'text-danger'}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            {msg}
          </motion.div>
        )}

        <div className="text-center">
          <motion.a
            href="/"
            className="text-primary text-decoration-underline fw-medium"
            whileHover={{ color: '#0d6efd' }}
          >
            Já tenho Conta! Quero fazer login
          </motion.a>
        </div>
      </motion.form>
    </motion.div>
  );
}

export default Cadastro;
