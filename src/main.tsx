import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// React 18 createRoot（避免 TS 对 React 19 自动类型的依赖问题）
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
