import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User, signOut } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
SCOPES.forEach((scope) => {
  provider.addScope(scope);
});

// Flag to indicate if we are in the middle of a sign-in flow
let isSigningIn = false;
// Cache the access token in memory (never in localStorage/sessionStorage)
let cachedAccessToken: string | null = null;

export interface AuthState {
  isConnected: boolean;
  user: User | null;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

// Initialize auth state listener. Call this on app load.
export const initGoogleAuth = (
  onChange: (state: AuthState) => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user && cachedAccessToken) {
      onChange({
        isConnected: true,
        user,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
      });
    } else if (user && !isSigningIn) {
      // User is logged in to Firebase but token is not in memory for this session
      // Still show signed-in user or prompt reconnect when needed
      onChange({
        isConnected: Boolean(cachedAccessToken),
        user,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
      });
    } else {
      cachedAccessToken = null;
      onChange({
        isConnected: false,
        user: null,
        email: null,
        displayName: null,
        photoURL: null,
      });
    }
  });
};

// Sign in and authorize Google Calendar scope
export const connectGoogleCalendar = async (): Promise<{ user: User; accessToken: string }> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain Google Calendar access token');
    }

    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Google Calendar connection error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getGoogleAccessToken = (): string | null => {
  return cachedAccessToken;
};

export const disconnectGoogleCalendar = async (): Promise<void> => {
  await signOut(auth);
  cachedAccessToken = null;
};
