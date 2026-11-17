'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase, hasSupabaseConfig } from '../lib/supabase';
import { User, Session } from '@supabase/supabase-js';

export interface Profile {
  id: string;
  email: string;
  display_name: string;
  avatar_url?: string;
  workspace_role?: 'owner' | 'admin' | 'member' | 'viewer';
  created_at: string;
}

interface AuthContextType {
  user: User | MockUser | null;
  profile: Profile | null;
  session: Session | MockSession | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  loginWithOAuth: (provider: 'google' | 'github') => Promise<void>;
}

// Mock Types for Local Fallback
export interface MockUser {
  id: string;
  email: string;
  user_metadata: {
    display_name: string;
  };
}

export interface MockSession {
  user: MockUser;
  access_token: string;
}

export interface MockUserData {
  id: string;
  email: string;
  password?: string;
  display_name: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | MockUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [session, setSession] = useState<Session | MockSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load and refresh session
  useEffect(() => {
    let mounted = true;

    async function initializeAuth() {
      if (hasSupabaseConfig) {
        try {
          // Get current session
          const { data: { session: activeSession } } = await supabase.auth.getSession();
          if (!mounted) return;

          if (activeSession) {
            setSession(activeSession);
            setUser(activeSession.user);
            
            // Fetch profile
            const { data: profileData, error: profileError } = await supabase
              .from('profiles')
              .select('*')
              .eq('id', activeSession.user.id)
              .single();
            
            if (!profileError && profileData) {
              setProfile(profileData as Profile);
            } else {
              // Fallback if profile doesn't exist yet in db
              setProfile({
                id: activeSession.user.id,
                email: activeSession.user.email || '',
                display_name: activeSession.user.user_metadata?.display_name || activeSession.user.email?.split('@')[0] || 'Uživatel',
                created_at: activeSession.user.created_at,
              });
            }
          }

          // Listen for auth state changes
          const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, newSession) => {
            if (!mounted) return;
            
            if (newSession) {
              setSession(newSession);
              setUser(newSession.user);
              
              // Fetch profile
              const { data: profileData } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', newSession.user.id)
                .single();
              
              if (profileData) {
                setProfile(profileData as Profile);
              } else {
                setProfile({
                  id: newSession.user.id,
                  email: newSession.user.email || '',
                  display_name: newSession.user.user_metadata?.display_name || newSession.user.email?.split('@')[0] || 'Uživatel',
                  created_at: newSession.user.created_at,
                });
              }
            } else {
              setSession(null);
              setUser(null);
              setProfile(null);
            }
            setIsLoading(false);
          });

          return () => {
            subscription.unsubscribe();
          };
        } catch (error) {
          console.error('Error initializing Supabase Auth:', error);
          if (mounted) setIsLoading(false);
        }
      } else {
        // --- LocalStorage Authentication Fallback ---
        try {
          // Simulate network delay for session check
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (!mounted) return;

          const storedSession = localStorage.getItem('kanban_mock_session');
          if (storedSession) {
            const parsedSession = JSON.parse(storedSession) as MockSession;
            setSession(parsedSession);
            setUser(parsedSession.user);
            
            // Get user's profile from mock database
            const mockProfiles = JSON.parse(localStorage.getItem('kanban_mock_profiles') || '[]');
            const foundProfile = mockProfiles.find((p: Profile) => p.id === parsedSession.user.id);
            if (foundProfile) {
              setProfile(foundProfile);
            } else {
              const defaultProfile = {
                id: parsedSession.user.id,
                email: parsedSession.user.email,
                display_name: parsedSession.user.user_metadata.display_name,
                created_at: new Date().toISOString(),
              };
              setProfile(defaultProfile);
            }
          }
        } catch (err) {
          console.error('Error recovering mock session:', err);
        } finally {
          if (mounted) setIsLoading(false);
        }
      }
    }

    initializeAuth();

    return () => {
      mounted = false;
    };
  }, []);

  // Login
  const login = async (email: string, password: string) => {
    setIsLoading(true);
    try {
      if (hasSupabaseConfig) {
        const { error, data } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        
        if (data.session) {
          setSession(data.session);
          setUser(data.user);
          // Profile is fetched asynchronously in useEffect onAuthStateChange
        }
      } else {
        // --- Mock Login ---
        const mockUsers: MockUserData[] = JSON.parse(localStorage.getItem('kanban_mock_users') || '[]');
        const matchedUser = mockUsers.find((u) => u.email.toLowerCase() === email.toLowerCase());
        
        if (!matchedUser || matchedUser.password !== password) {
          throw new Error('Neplatný e-mail nebo heslo.');
        }

        const mockUser: MockUser = {
          id: matchedUser.id,
          email: matchedUser.email,
          user_metadata: {
            display_name: matchedUser.display_name,
          },
        };

        const mockSession: MockSession = {
          user: mockUser,
          access_token: 'mock-jwt-token-' + mockUser.id,
        };

        localStorage.setItem('kanban_mock_session', JSON.stringify(mockSession));
        setSession(mockSession);
        setUser(mockUser);

        // Fetch mock profile
        const mockProfiles = JSON.parse(localStorage.getItem('kanban_mock_profiles') || '[]');
        const mockProfile = mockProfiles.find((p: Profile) => p.id === mockUser.id) || {
          id: mockUser.id,
          email: mockUser.email,
          display_name: mockUser.user_metadata.display_name,
          created_at: new Date().toISOString(),
        };
        setProfile(mockProfile);
      }
      setIsLoading(false);
    } catch (error) {
      setIsLoading(false);
      throw error;
    }
  };

  // Register
  const register = async (email: string, password: string, displayName: string) => {
    setIsLoading(true);
    try {
      if (hasSupabaseConfig) {
        const { error, data } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              display_name: displayName,
            },
          },
        });
        if (error) throw error;
        
        if (data.session) {
          setSession(data.session);
          setUser(data.user);
        } else if (data.user) {
          // If email verification is enabled, user might not get a session immediately.
          // In an MVP SaaS, we hope it signs in automatically or we provide a clear note.
          // Note: signUp auto-logs in if email verification is off.
          // Let's assume auto-login is active for MVP.
        }
      } else {
        // --- Mock Register ---
        const mockUsers: MockUserData[] = JSON.parse(localStorage.getItem('kanban_mock_users') || '[]');
        const emailExists = mockUsers.some((u) => u.email.toLowerCase() === email.toLowerCase());
        
        if (emailExists) {
          throw new Error('Uživatel s tímto e-mailem již existuje.');
        }

        const newId = `mock-user-${Date.now()}`;
        const newMockUser = {
          id: newId,
          email,
          password, // Stored in plain text for local mock testing only
          display_name: displayName,
        };

        mockUsers.push(newMockUser);
        localStorage.setItem('kanban_mock_users', JSON.stringify(mockUsers));

        // Create Profile
        const mockProfiles = JSON.parse(localStorage.getItem('kanban_mock_profiles') || '[]');
        const newProfile: Profile = {
          id: newId,
          email,
          display_name: displayName,
          created_at: new Date().toISOString(),
        };
        mockProfiles.push(newProfile);
        localStorage.setItem('kanban_mock_profiles', JSON.stringify(mockProfiles));

        // Auto-login
        const mockUser: MockUser = {
          id: newId,
          email,
          user_metadata: {
            display_name: displayName,
          },
        };

        const mockSession: MockSession = {
          user: mockUser,
          access_token: 'mock-jwt-token-' + newId,
        };

        localStorage.setItem('kanban_mock_session', JSON.stringify(mockSession));
        setSession(mockSession);
        setUser(mockUser);
        setProfile(newProfile);
      }
      setIsLoading(false);
    } catch (error) {
      setIsLoading(false);
      throw error;
    }
  };

  // Logout
  const logout = async () => {
    setIsLoading(true);
    try {
      if (hasSupabaseConfig) {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
      } else {
        localStorage.removeItem('kanban_mock_session');
      }
      setSession(null);
      setUser(null);
      setProfile(null);
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // OAuth přes Supabase. V demo režimu žádné skutečné přihlášení neexistuje --
  // dřív se tu tiše zakládal falešný účet se stejným heslem pro všechny.
  const loginWithOAuth = async (provider: 'google' | 'github') => {
    if (hasSupabaseConfig) {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: window.location.origin,
        },
      });
      if (error) throw error;
    } else {
      throw new Error('Přihlášení přes Google/GitHub vyžaduje Supabase a v demo režimu není dostupné.');
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        session,
        isLoading,
        login,
        register,
        logout,
        loginWithOAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
