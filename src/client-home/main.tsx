import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ClientHome from './ClientHome';
import '@/styles/global.css';
import '@/styles/themes/windows-xp.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ClientHome />
    </StrictMode>,
  );
}
