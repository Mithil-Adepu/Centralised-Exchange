"use client";

import { Toaster } from 'react-hot-toast';

export function ToastProvider() {
  return (
    <Toaster
      position="top-right"
      toastOptions={{
        duration: 4000,
        style: {
          background: '#1A1B23',
          color: '#FFFFFF',
          border: '1px solid #2A2B35',
          borderRadius: '0.5rem',
          padding: '16px',
          fontSize: '14px',
          boxShadow: '0 4px 16px 0 rgba(0, 0, 0, 0.2)',
        },
        success: {
          iconTheme: {
            primary: '#00C896',
            secondary: '#FFFFFF',
          },
          style: {
            border: '1px solid #00C896',
          },
        },
        error: {
          iconTheme: {
            primary: '#FF4976',
            secondary: '#FFFFFF',
          },
          style: {
            border: '1px solid #FF4976',
          },
        },
        loading: {
          iconTheme: {
            primary: '#8247E5',
            secondary: '#FFFFFF',
          },
        },
      }}
    />
  );
}

