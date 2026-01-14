import { useEffect, useRef, useCallback } from 'react';
import { useDebouncedCallback } from 'use-debounce';
import { useDashboardStore } from '../stores/useDashboardStore';
import type { WSMessage, LocalAccount, DashboardStats, AccountDiff } from '../types';

interface UseWebSocketOptions {
  autoConnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  token?: string;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const {
    autoConnect = true,
    reconnectInterval = 3000,
    maxReconnectAttempts = 10,
    token,
  } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<NodeJS.Timeout | null>(null);
  const isManualClose = useRef(false);

  const {
    setLocalAccounts,
    updateLocalAccount,
    setAccountsStats,
    setWsConnected,
    setLastUpdate,
    addNotification,
    preferences,
  } = useDashboardStore();

  const handleAccountsUpdate = useDebouncedCallback((diffs: AccountDiff[]) => {
    const store = useDashboardStore.getState();
    let accounts = [...store.localAccounts];
    
    for (const diff of diffs) {
      if (diff.op === 'add' && diff.account) {
        const exists = accounts.find(a => a.email === diff.email);
        if (!exists) {
          accounts.push(diff.account);
        }
      } else if (diff.op === 'update' && diff.changes) {
        accounts = accounts.map(a => 
          a.email === diff.email ? { ...a, ...diff.changes } : a
        );
      } else if (diff.op === 'remove') {
        accounts = accounts.filter(a => a.email !== diff.email);
      }
    }
    
    setLocalAccounts(accounts);
  }, 50);

  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const message: WSMessage = JSON.parse(event.data);
      
      switch (message.type) {
        case 'initial':
          if (message.data?.accounts) {
            setLocalAccounts(message.data.accounts);
          }
          if (message.data?.stats) {
            setAccountsStats(message.data.stats);
          }
          setLastUpdate(message.timestamp);
          break;
          
        case 'accounts_update':
          if (message.data?.diffs) {
            handleAccountsUpdate(message.data.diffs);
          }
          setLastUpdate(message.timestamp);
          break;
          
        case 'rate_limit_change':
          if (message.data) {
            const { email, family, cleared } = message.data;
            if (cleared && preferences.notifyOnRateLimitClear && typeof email === 'string' && typeof family === 'string') {
              addNotification({
                type: 'success',
                title: 'Rate Limit Cleared',
                message: `${email} is now available for ${family}`,
              });
            }
          }
          setLastUpdate(message.timestamp);
          break;
          
        case 'stats_update':
          if (message.data) {
            setAccountsStats(message.data);
          }
          setLastUpdate(message.timestamp);
          break;
          
        case 'heartbeat':
          break;
          
        default:
          console.log('[useWebSocket] Unknown message type:', message.type);
      }
    } catch (e) {
      console.error('[useWebSocket] Failed to parse message:', e);
    }
  }, [setLocalAccounts, setAccountsStats, setLastUpdate, handleAccountsUpdate, addNotification, preferences]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    isManualClose.current = false;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = token 
      ? `${wsProtocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`
      : `${wsProtocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[useWebSocket] Connected');
      setWsConnected(true);
      reconnectAttempts.current = 0;
    };

    ws.onmessage = handleMessage;

    ws.onclose = () => {
      console.log('[useWebSocket] Disconnected');
      setWsConnected(false);
      wsRef.current = null;

      if (!isManualClose.current && reconnectAttempts.current < maxReconnectAttempts) {
        const delay = Math.min(reconnectInterval * Math.pow(1.5, reconnectAttempts.current), 30000);
        console.log(`[useWebSocket] Reconnecting in ${delay}ms...`);
        
        reconnectTimer.current = setTimeout(() => {
          reconnectAttempts.current++;
          connect();
        }, delay);
      }
    };

    ws.onerror = (error) => {
      console.error('[useWebSocket] Error:', error);
    };

    wsRef.current = ws;
  }, [handleMessage, setWsConnected, reconnectInterval, maxReconnectAttempts]);

  const disconnect = useCallback(() => {
    isManualClose.current = true;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setWsConnected(false);
  }, [setWsConnected]);

  const send = useCallback((message: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

  return {
    connect,
    disconnect,
    send,
    isConnected: wsRef.current?.readyState === WebSocket.OPEN,
  };
}
