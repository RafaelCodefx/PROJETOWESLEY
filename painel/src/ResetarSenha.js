// ResetarSenha.js
import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';

function ResetarSenha() {
  const { token } = useParams();
  const [novaSenha, setNovaSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [msg, setMsg] = useState('');
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (novaSenha !== confirmacao) {
      setMsg('As senhas não coincidem.');
      return;
    }

    try {
      const res = await axios.post(`http://localhost:3001/api/resetar-senha/${token}`, {
        novaSenha
      });
      setMsg(res.data.msg || 'Senha redefinida com sucesso!');
      setTimeout(() => navigate('/'), 2500); // volta para login
    } catch (err) {
      setMsg('Erro ao redefinir senha. Token inválido ou expirado.');
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #f1f4f9, #dff1ff)',
      padding: '1rem',
      fontFamily: '"Segoe UI", sans-serif'
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          background: '#fff',
          padding: '2.5rem',
          borderRadius: '16px',
          boxShadow: '0 10px 30px rgba(0, 0, 0, 0.07)',
          maxWidth: '380px',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.2rem'
        }}
      >
        <h2 style={{ textAlign: 'center', color: '#007bff' }}>Nova senha</h2>

        <input
          type="password"
          placeholder="Nova senha"
          value={novaSenha}
          onChange={e => setNovaSenha(e.target.value)}
          required
          style={{ padding: '12px', borderRadius: '8px', border: '1px solid #ccc' }}
        />

        <input
          type="password"
          placeholder="Confirmar nova senha"
          value={confirmacao}
          onChange={e => setConfirmacao(e.target.value)}
          required
          style={{ padding: '12px', borderRadius: '8px', border: '1px solid #ccc' }}
        />

        <button type="submit" style={{
          padding: '12px',
          borderRadius: '8px',
          background: '#007bff',
          color: '#fff',
          fontWeight: '600',
          border: 'none',
          cursor: 'pointer'
        }}>
          Redefinir senha
        </button>

        {msg && (
          <div style={{
            background: msg.includes('sucesso') ? '#d4edda' : '#f8d7da',
            color: msg.includes('sucesso') ? '#155724' : '#721c24',
            padding: '10px',
            borderRadius: '6px',
            textAlign: 'center',
            fontSize: '14px'
          }}>
            {msg}
          </div>
        )}
      </form>
    </div>
  );
}

export default ResetarSenha;
