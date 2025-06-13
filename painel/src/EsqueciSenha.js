import React, { useState } from 'react';
import axios from 'axios';
import { FaEnvelopeOpenText } from 'react-icons/fa';

function EsqueciSenha() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMsg('');
    try {
      const res = await axios.post('http://localhost:3001/api/esqueci-senha', { email });
      setMsg(res.data.msg || 'Instruções enviadas.');
    } catch (err) {
      setMsg('Erro ao enviar e-mail. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #f5f8ff, #e3f2fd)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: '"Segoe UI", sans-serif',
      padding: '1.5rem'
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          background: '#fff',
          padding: '3rem',
          borderRadius: '20px',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.06)',
          maxWidth: '420px',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '1.5rem',
          animation: 'fadeIn 0.8s ease-in-out'
        }}
      >
        <FaEnvelopeOpenText size={48} color="#007bff" />
        <h2 style={{ margin: 0, fontSize: '24px', color: '#212529' }}>
          Recuperar acesso
        </h2>
        <p style={{ color: '#6c757d', fontSize: '15px', textAlign: 'center' }}>
          Informe o e-mail cadastrado para enviarmos um link de redefinição de senha.
        </p>

        <input
          type="email"
          placeholder="Seu e-mail"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          style={{
            padding: '12px 14px',
            borderRadius: '8px',
            border: '1px solid #ced4da',
            fontSize: '15px',
            width: '100%',
            outline: 'none',
            transition: 'border 0.3s ease'
          }}
          onFocus={(e) => e.target.style.border = '1px solid #007bff'}
          onBlur={(e) => e.target.style.border = '1px solid #ced4da'}
        />

        <button
          type="submit"
          disabled={loading}
          style={{
            padding: '12px 20px',
            borderRadius: '8px',
            background: loading ? '#6c757d' : '#007bff',
            color: '#fff',
            fontWeight: '600',
            fontSize: '15px',
            border: 'none',
            cursor: loading ? 'not-allowed' : 'pointer',
            width: '100%',
            transition: 'background 0.2s ease'
          }}
        >
          {loading ? 'Enviando...' : 'Enviar link de recuperação'}
        </button>

        {msg && (
          <div style={{
            background: msg.toLowerCase().includes('erro') ? '#f8d7da' : '#d4edda',
            color: msg.toLowerCase().includes('erro') ? '#721c24' : '#155724',
            padding: '10px 14px',
            borderRadius: '6px',
            fontSize: '14px',
            width: '100%',
            textAlign: 'center',
            boxShadow: '0 1px 4px rgba(0,0,0,0.05)'
          }}>
            {msg}
          </div>
        )}
      </form>

      {/* Animação leve */}
      <style>
        {`
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}
      </style>
    </div>
  );
}

export default EsqueciSenha;
