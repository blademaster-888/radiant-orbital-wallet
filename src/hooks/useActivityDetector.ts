import { useEffect } from 'react';
import { storage } from '../utils/storage';
import { locked } from '../signals';
import { useSignals } from '@preact/signals-react/runtime';

export const useActivityDetector = () => {
  useSignals();
  useEffect(() => {
    const handleActivity = async () => {
      if (locked.value) return;

      const timestamp = Date.now();
      storage.set({ lastActiveTime: timestamp });
    };

    const events = ['mousemove', 'keydown', 'touchstart', 'scroll'] as const;
    events.forEach((e) => document.addEventListener(e, handleActivity));

    return () => {
      events.forEach((e) => document.removeEventListener(e, handleActivity));
    };
  }, []);
};
