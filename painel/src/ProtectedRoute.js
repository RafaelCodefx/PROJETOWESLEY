// src/ProtectedRoute.js
import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';

const ProtectedRoute = () => {
  // Agora pegamos o objeto "auth" inteiro (que contém { token: "..." })
  const stored = localStorage.getItem('auth');
  const auth = stored ? JSON.parse(stored) : null;

  // Se não existir auth ou auth.token, volta para "/"
  return auth && auth.token 
    ? <Outlet /> 
    : <Navigate to="/" replace />;
};

export default ProtectedRoute;
