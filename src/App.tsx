/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  CheckCircle2, 
  ChevronRight, 
  ChevronLeft, 
  BookOpen, 
  GraduationCap, 
  History,
  Info,
  CheckCircle,
  RotateCcw,
  Sparkles,
  Trash2,
  Volume2,
  Loader2,
  LogIn,
  LogOut,
  User as UserIcon
} from 'lucide-react';
import { WORD_LIST, Word } from './constants';
import { generateMoreWords } from './services/geminiService';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  serverTimestamp,
  User
} from './lib/firebase';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

type Tab = 'learn' | 'study' | 'learned' | 'bin';

interface Progress {
  skippedIds: number[];    // "Don't show again" from Learn
  learningIds: number[];   // In Study list
  masteredIds: number[];   // Mastered from Study list (Learned tab)
}

// Heuristic to fix missing or incorrect parts of speech
const autoCategorize = (en: string, currentType?: string): string => {
  // If it's already a valid part of speech, leave it
  const VALID_TYPES = ['Noun', 'Verb', 'Adjective', 'Adverb', 'Preposition', 'Conjunction'];
  if (currentType && VALID_TYPES.includes(currentType)) return currentType;
  
  const word = en.toLowerCase().trim();
  // Verbs (Synthesize, Analyze, Create, Fix)
  if (word.endsWith('ize') || word.endsWith('ise') || word.endsWith('ate') || word.endsWith('ify') || word.endsWith('en')) return 'Verb';
  // Adverbs (Nicely, Quickly)
  if (word.endsWith('ly')) return 'Adverb';
  // Adjectives (Creative, Educational, Academic)
  if (word.endsWith('ive') || word.endsWith('al') || word.endsWith('ic') || word.endsWith('ous') || word.endsWith('able') || word.endsWith('ible') || word.endsWith('ful') || word.endsWith('less')) return 'Adjective';
  // Nouns (Creation, Settlement, Happiness, Reality, Importance, Difference)
  if (word.endsWith('tion') || word.endsWith('sion') || word.endsWith('ment') || word.endsWith('ness') || word.endsWith('ity') || word.endsWith('ance') || word.endsWith('ence') || word.endsWith('ship')) return 'Noun';
  
  // Default fallback for legacy bad data
  return (currentType === 'Academic' || !currentType || currentType === 'Vocab') ? 'Noun' : currentType;
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('learn');
  const [flippedCards, setFlippedCards] = useState<Set<number>>(new Set());
  const [isConfirmingReset, setIsConfirmingReset] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  
  const [extraWords, setExtraWords] = useState<Word[]>(() => {
    const saved = localStorage.getItem('lexiflow_v2_extra_words');
    try {
      const words: Word[] = saved ? JSON.parse(saved) : [];
      return words.map(w => ({ ...w, type: autoCategorize(w.en, w.type) }));
    } catch { return []; }
  });

  const [hasLoadedFromCloud, setHasLoadedFromCloud] = useState(false);
  const allWords = useMemo(() => {
    const combined = [...WORD_LIST, ...extraWords];
    return combined.sort((a, b) => a.en.toLowerCase().localeCompare(b.en.toLowerCase()));
  }, [extraWords]);
  const [progress, setProgress] = useState<Progress>(() => {
    const saved = localStorage.getItem('lexiflow_v2_progress');
    const defaultProgress = { skippedIds: [], learningIds: [], masteredIds: [] };
    if (!saved) {
      // Check for old format
      const oldSaved = localStorage.getItem('lexiflow_progress');
      if (oldSaved) {
        try {
          const old = JSON.parse(oldSaved);
          return {
            ...defaultProgress,
            skippedIds: Array.isArray(old.knownIds) ? old.knownIds : [],
            learningIds: Array.isArray(old.learningIds) ? old.learningIds : [],
          };
        } catch { return defaultProgress; }
      }
      return defaultProgress;
    }
    try {
      const parsed = JSON.parse(saved);
      return {
        ...defaultProgress,
        ...parsed,
        skippedIds: Array.isArray(parsed.skippedIds) ? parsed.skippedIds : [],
        learningIds: Array.isArray(parsed.learningIds) ? parsed.learningIds : [],
        masteredIds: Array.isArray(parsed.masteredIds) ? parsed.masteredIds : [],
      };
    } catch {
      return defaultProgress;
    }
  });

  const pageSize = 100;

  // Global hidden pool for available words: skipped OR learning OR mastered
  const unavailablePool = useMemo(() => 
    new Set([...progress.skippedIds, ...progress.learningIds, ...progress.masteredIds]),
    [progress.skippedIds, progress.learningIds, progress.masteredIds]
  );

  // Fresh words (not seen/skipped/learning/learned)
  const availableWords = useMemo(() => 
    allWords.filter(w => !unavailablePool.has(w.id)),
    [allWords, unavailablePool]
  );

  // Words for each view
  const studyWords = useMemo(() => 
    allWords.filter(w => progress.learningIds.includes(w.id)),
    [allWords, progress.learningIds]
  );

  const learnedWords = useMemo(() => 
    allWords.filter(w => progress.masteredIds.includes(w.id)),
    [allWords, progress.masteredIds]
  );

  const binWords = useMemo(() => 
    allWords.filter(w => progress.skippedIds.includes(w.id)),
    [allWords, progress.skippedIds]
  );

  const displayedWords = useMemo(() => {
    if (activeTab === 'learn') {
      return availableWords.slice(0, pageSize);
    }
    if (activeTab === 'study') return studyWords;
    if (activeTab === 'learned') return learnedWords;
    return binWords;
  }, [activeTab, availableWords, pageSize, studyWords, learnedWords, binWords]);

  const fetchMore = async () => {
    setIsLoadingMore(true);
    try {
      const existingEnWords = allWords.map(w => w.en);
      const newWords = await generateMoreWords(existingEnWords);
      
      const newWordsWithIds = newWords.map((w, i) => ({
        ...w,
        id: (allWords[allWords.length - 1]?.id || 1000) + i + 1
      }));

      setExtraWords(prev => {
        const next = [...prev, ...newWordsWithIds];
        localStorage.setItem('lexiflow_v2_extra_words', JSON.stringify(next));
        return next;
      });

      // Show the new words immediately
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      console.error("Failed to fetch more words:", error);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const loadNextBatch = () => {
    if (availableWords.length > pageSize) {
      setFlippedCards(new Set());
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      fetchMore();
    }
  };

  const progressPercentage = Math.round(((progress.skippedIds.length + progress.masteredIds.length) / (allWords.length || 1)) * 100);

  // Auth Listener
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      console.log("Auth state changed:", { 
        uid: u?.uid, 
        email: u?.email, 
        displayName: u?.displayName,
        isAnonymous: u?.isAnonymous
      });
      setUser(u);
      setHasLoadedFromCloud(false); // Reset cloud load state on user change
      setAuthLoading(false);
    });
  }, []);

  // Firestore Listener (Download from Cloud)
  useEffect(() => {
    if (!user) return;

    const path = `users/${user.uid}/state/main`;
    const userDocRef = doc(db, 'users', user.uid, 'state', 'main');
    
    console.log("Firestore op: Starting Snapshot Listener", { uid: user.uid, path });
    const unsubscribe = onSnapshot(userDocRef, (snapshot) => {
      // Don't overwrite local changes that haven't reached the server yet
      if (snapshot.metadata.hasPendingWrites) return;

      if (snapshot.exists()) {
        const data = snapshot.data();
        if (data.extraWords) {
          // Cleanup legacy words where "Academic" or "Vocab" might have been incorrectly put as the type
          const cleanedExtraWords = data.extraWords.map((w: any) => ({
            ...w,
            type: autoCategorize(w.en, w.type)
          }));
          setExtraWords(cleanedExtraWords);
        }
        if (data.skippedIds || data.learningIds || data.masteredIds) {
          setProgress(prev => {
            const next = {
              skippedIds: data.skippedIds || [],
              learningIds: data.learningIds || [],
              masteredIds: data.masteredIds || []
            };
            if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
            return next;
          });
        }
      }
      setHasLoadedFromCloud(true);
    }, (error) => {
      console.error("Firestore Listen Error:", error);
      if (error.code === 'permission-denied') {
        handleFirestoreError(error, OperationType.GET, `users/${user.uid}/state/main`);
      } else {
        // For other errors, we still want to allow the app to function locally
        setHasLoadedFromCloud(true);
      }
    });

    return () => unsubscribe();
  }, [user]);

  // Push to Firestore on change
  useEffect(() => {
    if (!user || !hasLoadedFromCloud) {
      localStorage.setItem('lexiflow_v2_progress', JSON.stringify(progress));
      localStorage.setItem('lexiflow_v2_extra_words', JSON.stringify(extraWords));
      return;
    }

    const syncData = async () => {
      if (!user) return;
      setIsSyncing(true);
      const path = `users/${user.uid}/state/main`;
      try {
        const userDocRef = doc(db, 'users', user.uid, 'state', 'main');
        console.log("Firestore op: Writing State", { uid: user.uid, path });
        await setDoc(userDocRef, {
          skippedIds: progress.skippedIds,
          learningIds: progress.learningIds,
          masteredIds: progress.masteredIds,
          extraWords,
          updatedAt: serverTimestamp(),
        }, { merge: true });
        
        // Also update local storage as a "cache"
        localStorage.setItem('lexiflow_v2_progress', JSON.stringify(progress));
        localStorage.setItem('lexiflow_v2_extra_words', JSON.stringify(extraWords));
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/state/main`);
      } finally {
        setIsSyncing(false);
      }
    };

    const timer = setTimeout(syncData, 3000);
    return () => clearTimeout(timer);
  }, [progress, extraWords, user, hasLoadedFromCloud]);

  // Initial connection test
  useEffect(() => {
    if (!user) return;
    const testConnection = async () => {
      const path = `users/${user.uid}/state/connection-test`;
      try {
        const { getDocFromServer } = await import('firebase/firestore');
        console.log("Firestore op: Connection Test", { uid: user.uid, path });
        await getDocFromServer(doc(db, 'users', user.uid, 'state', 'connection-test'));
      } catch (error) {
        console.log("Connection test result:", error);
      }
    };
    testConnection();
  }, [user]);

  // Warm up the speech-synthesis voice list. getVoices() is often empty on the
  // first call until the browser fires "voiceschanged"; priming it here ensures
  // a UK/AU voice is available the moment the user clicks a pronunciation flag.
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const warm = () => window.speechSynthesis.getVoices();
    warm();
    window.speechSynthesis.addEventListener?.('voiceschanged', warm);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', warm);
  }, []);

  const handleLogin = async () => {
    console.log("Login triggered...");
    try {
      const result = await signInWithPopup(auth, googleProvider);
      console.log("Login successful:", result.user.email);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  const toggleSkip = (id: number) => {
    setProgress(prev => ({
      ...prev,
      skippedIds: prev.skippedIds.includes(id) ? prev.skippedIds.filter(i => i !== id) : [...prev.skippedIds, id],
      learningIds: prev.learningIds.filter(i => i !== id),
      masteredIds: prev.masteredIds.filter(i => i !== id)
    }));
  };

  const toggleLearning = (id: number) => {
    setProgress(prev => {
      const isLearning = prev.learningIds.includes(id);
      return {
        ...prev,
        learningIds: isLearning ? prev.learningIds.filter(l => l !== id) : [...new Set([...prev.learningIds, id])],
        skippedIds: prev.skippedIds.filter(k => k !== id),
        masteredIds: prev.masteredIds.filter(m => m !== id)
      };
    });
  };

  const toggleMastered = (id: number) => {
    setProgress(prev => {
      const isMastered = prev.masteredIds.includes(id);
      return {
        ...prev,
        masteredIds: isMastered ? prev.masteredIds.filter(m => m !== id) : [...new Set([...prev.masteredIds, id])],
        learningIds: prev.learningIds.filter(l => l !== id),
        skippedIds: prev.skippedIds.filter(k => k !== id)
      };
    });
  };

  const toggleFlip = (id: number) => {
    setFlippedCards(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Pick the best available voice for a prioritized list of locales.
  // Unlike Chrome (which ships Google's cloud voices), Electron only exposes the
  // OS voices, so we must explicitly select an en-GB/en-AU voice instead of
  // relying on utterance.lang, which otherwise falls back to the default US voice.
  const pickVoice = (localePrefs: string[]): SpeechSynthesisVoice | null => {
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;
    const norm = (l: string) => l.replace('_', '-').toLowerCase();
    // 1) Exact locale match (e.g. "en-gb").
    for (const pref of localePrefs) {
      const match = voices.find((v) => norm(v.lang) === pref.toLowerCase());
      if (match) return match;
    }
    // 2) Region prefix match (e.g. "en-gb-scotland").
    for (const pref of localePrefs) {
      const match = voices.find((v) => norm(v.lang).startsWith(pref.toLowerCase()));
      if (match) return match;
    }
    return null;
  };

  const speak = (text: string, lang: 'en-US' | 'en-GB' = 'en-US') => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel(); // Stop any current speech
    const utterance = new SpeechSynthesisUtterance(text);

    // For the "UK/AU" button prefer British, then other non-US English accents.
    const prefs = lang === 'en-GB'
      ? ['en-GB', 'en-AU', 'en-IE', 'en-NZ', 'en-ZA']
      : ['en-US', 'en-CA'];
    const voice = pickVoice(prefs);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = lang;
    }
    utterance.rate = 0.9; // Slightly slower for clarity
    window.speechSynthesis.speak(utterance);
  };

  const handleReset = () => {
    if (!isConfirmingReset) {
      setIsConfirmingReset(true);
      // Auto-cancel confirmation after 3 seconds
      setTimeout(() => setIsConfirmingReset(false), 3000);
      return;
    }
    const defaultProgress = { skippedIds: [], learningIds: [], masteredIds: [] };
    setProgress(defaultProgress);
    setExtraWords([]);
    setFlippedCards(new Set());
    setIsConfirmingReset(false);
    localStorage.removeItem('lexiflow_v2_progress');
    localStorage.removeItem('lexiflow_v2_extra_words');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-100 font-sans selection:bg-sky-500/30 pb-20">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-[#0f172a]/80 backdrop-blur-md border-b border-white/5 px-6 py-4">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-sky-500 rounded-xl shadow-lg shadow-sky-500/20">
              <GraduationCap className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">LexiFlow IELTS</h1>
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Academic Cantonese Prep</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-4 border-r border-white/5 pr-4 mr-2">
              {authLoading ? (
                <Loader2 className="w-5 h-5 text-sky-400 animate-spin" />
              ) : user ? (
                <div className="flex items-center gap-3">
                  <div className="flex flex-col items-end">
                    <span className="text-xs font-bold text-white truncate max-w-[120px] md:max-w-[150px]">{user.displayName}</span>
                    <button 
                      onClick={handleLogout}
                      className="text-[10px] text-slate-500 hover:text-red-400 font-bold uppercase tracking-wider flex items-center gap-1 transition-colors"
                    >
                      <LogOut className="w-2.5 h-2.5" />
                      Sign Out
                    </button>
                  </div>
                  {user.photoURL ? (
                    <img src={user.photoURL} alt="Profile" className="w-8 h-8 rounded-full border border-sky-500/30" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center border border-white/10">
                      <UserIcon className="w-4 h-4 text-slate-400" />
                    </div>
                  )}
                </div>
              ) : (
                <button
                  onClick={handleLogin}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-900 hover:bg-slate-800 rounded-xl text-xs font-bold transition-all border border-white/5"
                >
                  <LogIn className="w-3.5 h-3.5 text-sky-400" />
                  Sign In
                </button>
              )}
            </div>

            <div className="flex flex-col items-end">
              <div className="flex items-center gap-2 mb-1">
                {isSyncing && <Loader2 className="w-2.5 h-2.5 text-sky-400 animate-spin" />}
                <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Progress</span>
                <span className="text-sm font-bold text-sky-400">{progressPercentage}%</span>
              </div>
              <div className="w-32 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${progressPercentage}%` }}
                  className="h-full bg-sky-400" 
                />
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10">
        {/* Navigation Tabs */}
        <div className="flex overflow-x-auto gap-2 mb-10 p-1.5 bg-slate-900/50 rounded-2xl w-fit border border-white/5 no-scrollbar">
          <button
            onClick={() => { setActiveTab('learn'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold whitespace-nowrap transition-all ${
              activeTab === 'learn' 
                ? 'bg-sky-500 text-white shadow-xl shadow-sky-500/20' 
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <BookOpen className="w-4 h-4" />
            Learn
          </button>
          <button
            onClick={() => { setActiveTab('study'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold whitespace-nowrap transition-all ${
              activeTab === 'study' 
                ? 'bg-amber-500 text-white shadow-xl shadow-amber-500/20' 
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <History className="w-4 h-4" />
            Study ({studyWords.length})
          </button>
          <button
            onClick={() => { setActiveTab('learned'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold whitespace-nowrap transition-all ${
              activeTab === 'learned' 
                ? 'bg-emerald-500 text-white shadow-xl shadow-emerald-500/20' 
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            Learned ({learnedWords.length})
          </button>
          <button
            onClick={() => { setActiveTab('bin'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold whitespace-nowrap transition-all ${
              activeTab === 'bin' 
                ? 'bg-red-500 text-white shadow-xl shadow-red-500/20' 
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Trash2 className="w-4 h-4" />
            Bin ({binWords.length})
          </button>
        </div>

        {/* Word Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          <AnimatePresence mode="popLayout">
            {displayedWords.length > 0 ? (
              displayedWords.map((word) => (
                <div key={word.id} className="relative h-72 w-full perspective-2000">
                  <motion.div
                    className="relative w-full h-full preserve-3d"
                    initial={false}
                    animate={{ rotateY: flippedCards.has(word.id) ? 180 : 0 }}
                    transition={{ type: 'spring', stiffness: 120, damping: 20 }}
                  >
                    {/* Front of Card */}
                    <div className="absolute inset-0 backface-hidden">
                      <div className="h-full group p-7 rounded-[2rem] border bg-[#1e293b] border-white/5 hover:border-sky-500/30 transition-all flex flex-col justify-between shadow-2xl">
                        <div>
                          <div className="flex justify-between items-start mb-2">
                              <div className="flex items-center gap-2">
                                <h3 className="text-2xl font-black text-white tracking-tight group-hover:text-sky-400 transition-colors">
                                  {word.en}
                                </h3>
                                <div className="flex gap-1 bg-slate-900/50 p-1 rounded-lg border border-white/5">
                                  {/* US Flag */}
                                  <div className="relative group/flag">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        speak(word.en, 'en-US');
                                      }}
                                      className="w-6 h-4 overflow-hidden rounded-sm hover:scale-110 transition-transform flex-shrink-0"
                                      title="US Pronunciation"
                                    >
                                      <svg viewBox="0 0 741 390" className="w-full h-full">
                                        <rect width="741" height="390" fill="#3c3b6e"/>
                                        <g fill="#fff">
                                          <rect width="741" height="30" y="0"/>
                                          <rect width="741" height="30" y="60"/>
                                          <rect width="741" height="30" y="120"/>
                                          <rect width="741" height="30" y="180"/>
                                          <rect width="741" height="30" y="240"/>
                                          <rect width="741" height="30" y="300"/>
                                          <rect width="741" height="30" y="360"/>
                                        </g>
                                        <rect width="741" height="30" y="30" fill="#b22234"/>
                                        <rect width="741" height="30" y="90" fill="#b22234"/>
                                        <rect width="741" height="30" y="150" fill="#b22234"/>
                                        <rect width="741" height="30" y="210" fill="#b22234"/>
                                        <rect width="741" height="30" y="270" fill="#b22234"/>
                                        <rect width="741" height="30" y="330" fill="#b22234"/>
                                        <rect width="296.4" height="210" fill="#3c3b6e"/>
                                        <g fill="#fff">
                                          <g id="s18">
                                            <g id="s9">
                                              <g id="s5">
                                                <g id="s">
                                                  <path d="M247,6.5l.6,1.8h1.9l-1.5,1.1.6,1.8-1.5-1.1-1.5,1.1.6-1.8-1.5-1.1h1.9z" transform="scale(0.05)"/>
                                                </g>
                                              </g>
                                            </g>
                                          </g>
                                        </g>
                                        {/* Simplified US flag representation for performance in cards */}
                                        <rect width="296" height="210" fill="#3c3b6e"/>
                                        <path d="M0 0h296v210H0z" fill="#3c3b6e"/>
                                        <circle cx="148" cy="105" r="50" fill="white" opacity="0.1" />
                                      </svg>
                                      {/* Using emoji as fallback if complex SVG is too heavy for large grid */}
                                    </button>
                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover/flag:block z-[60]">
                                      <div className="bg-slate-950 text-white text-[10px] py-1 px-2 rounded-md border border-sky-500/50 shadow-xl whitespace-nowrap">
                                        <span className="text-slate-500 mr-1">US:</span> {word.en}
                                      </div>
                                      <div className="w-2 h-2 bg-slate-950 border-r border-b border-sky-500/50 rotate-45 absolute -bottom-1 left-1/2 -translate-x-1/2" />
                                    </div>
                                  </div>

                                  {/* UK Flag */}
                                  <div className="relative group/flag">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        speak(word.en_gb || word.en, 'en-GB');
                                      }}
                                      className="w-6 h-4 overflow-hidden rounded-sm hover:scale-110 transition-transform flex-shrink-0 relative group"
                                      title="UK/AU Pronunciation"
                                    >
                                      <svg viewBox="0 0 60 30" className="w-full h-full">
                                        <clipPath id="s">
                                          <path d="M0,0 v30 h60 v-30 z"/>
                                        </clipPath>
                                        <path d="M0,0 v30 h60 v-30 z" fill="#012169"/>
                                        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6"/>
                                        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" strokeWidth="4"/>
                                        <path d="M30,0 v30 M0,15 h60" stroke="#fff" strokeWidth="10"/>
                                        <path d="M30,0 v30 M0,15 h60" stroke="#C8102E" strokeWidth="6"/>
                                      </svg>
                                    </button>
                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover/flag:block z-[60]">
                                      <div className="bg-slate-950 text-white text-[10px] py-1 px-2 rounded-md border border-amber-500/50 shadow-xl whitespace-nowrap">
                                        <span className="text-slate-500 mr-1">UK/AU:</span> {word.en_gb || word.en}
                                      </div>
                                      <div className="w-2 h-2 bg-slate-950 border-r border-b border-amber-500/50 rotate-45 absolute -bottom-1 left-1/2 -translate-x-1/2" />
                                    </div>
                                  </div>
                                </div>
                              </div>
                            <div className="flex gap-2">
                              {activeTab === 'bin' ? (
                                <button
                                  title="Recover to Learn"
                                  onClick={() => toggleSkip(word.id)}
                                  className="p-2 transition-all border border-white/5 rounded-full bg-red-500 text-white shadow-lg shadow-red-500/20"
                                >
                                  <RotateCcw className="w-4 h-4" />
                                </button>
                              ) : activeTab === 'learn' && (
                                <button
                                  title="Don't show again"
                                  onClick={() => toggleSkip(word.id)}
                                  className="p-2 transition-all border border-white/5 rounded-full bg-slate-800/50 text-slate-500 hover:bg-red-500/10 hover:text-red-400"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                              <button
                                title={activeTab === 'study' ? "Mark as Learned" : activeTab === 'learned' ? "Back to Study" : "Add to Study List"}
                                onClick={() => activeTab === 'study' ? toggleMastered(word.id) : toggleLearning(word.id)}
                                className={`p-2.5 rounded-full transition-all border border-white/10 ${
                                  activeTab === 'study'
                                    ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20'
                                    : progress.learningIds.includes(word.id)
                                      ? 'bg-amber-500 text-white shadow-lg shadow-amber-500/20'
                                      : (activeTab === 'bin' ? 'bg-slate-800 text-slate-500 hover:text-white hover:bg-amber-500/20' : 'bg-slate-800 text-slate-500 hover:text-white hover:bg-slate-700')
                                }`}
                              >
                                {activeTab === 'study' ? <CheckCircle2 className="w-5 h-5" /> : <BookOpen className="w-5 h-5" />}
                              </button>
                            </div>
                          </div>
                          <p className="text-sky-400 font-bold text-xl mb-4 italic">
                            {word.zh}
                          </p>
                          <p className="text-sm text-slate-400 font-medium leading-relaxed line-clamp-3">
                            {word.definition}
                          </p>
                        </div>
                        
                        <div className="flex items-center justify-between mt-auto">
                          <div className="flex items-center gap-2">
                            <span className={`text-[9px] font-black uppercase tracking-[0.2em] px-3 py-1.5 rounded-lg border shadow-sm ${
                              word.type === 'Noun' ? 'bg-sky-500/10 text-sky-400 border-sky-500/20' :
                              word.type === 'Verb' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                              word.type === 'Adjective' ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' :
                              word.type === 'Adverb' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                              word.type === 'Preposition' ? 'bg-pink-500/10 text-pink-400 border-pink-500/20' :
                              word.type === 'Conjunction' ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' :
                              'bg-slate-900/80 text-slate-500 border-white/5'
                            }`}>
                              {word.type || 'Noun'}
                            </span>
                          </div>
                          <button
                            onClick={() => toggleFlip(word.id)}
                            className="text-xs font-black text-sky-400 hover:text-sky-300 flex items-center gap-2 transition-all px-4 py-2 rounded-xl bg-sky-500/10 hover:shadow-lg hover:shadow-sky-500/10 border border-sky-500/20"
                          >
                            Usage
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Back of Card */}
                    <div className="absolute inset-0 backface-hidden [transform:rotateY(180deg)]">
                      <div className="h-full p-8 rounded-[2rem] border bg-[#0f172a] border-sky-500/40 flex flex-col shadow-[inset_0_0_40px_rgba(14,165,233,0.05)]">
                        <div className="flex justify-between items-center mb-6">
                           <span className="text-[10px] font-black text-sky-400 flex items-center gap-2 uppercase tracking-[0.2em]">
                            <Sparkles className="w-4 h-4" /> Context Examples
                          </span>
                        </div>
                        
                        <div className="flex-1 overflow-y-auto space-y-5 pr-2 custom-scrollbar">
                          {word.examples.map((ex, i) => (
                            <div key={i} className="relative">
                              <div className="absolute left-0 top-0 bottom-0 w-1 bg-sky-500/20 rounded-full" />
                              <p className="text-sm text-slate-300 pl-5 font-medium leading-relaxed">
                                {ex}
                              </p>
                            </div>
                          ))}
                        </div>

                        <div className="mt-6 flex justify-end">
                           <button
                            onClick={() => toggleFlip(word.id)}
                            className="bg-slate-800 hover:bg-slate-700 text-white rounded-xl p-3 transition-all shadow-xl border border-white/5 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest"
                          >
                            <RotateCcw className="w-4 h-4" />
                            Return
                          </button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                </div>
              ))
            ) : (
              <div className="col-span-full py-32 text-center">
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-slate-900 border border-white/5 mb-6 text-slate-600"
                >
                  <Info className="w-10 h-10" />
                </motion.div>
                <h3 className="text-2xl font-bold text-white mb-3">
                  {activeTab === 'learn' ? "End of Library" : activeTab === 'study' ? "Your study list is empty" : "No mastered words yet"}
                </h3>
                <p className="text-slate-500 max-w-sm mx-auto font-medium">
                  {activeTab === 'learn' 
                    ? "You've reviewed all available words. Refine your knowledge in Study tab." 
                    : activeTab === 'study' 
                      ? "Mark words with the book icon in the Learn tab to start focused studying."
                      : "The words you master in Study mode will appear here for long-term review."}
                </p>
              </div>
            )}
          </AnimatePresence>
        </div>

        {/* Pagination & Next Button */}
        {activeTab === 'learn' && (
          <div className="mt-16 flex flex-col items-center gap-8">
            {(displayedWords.length === 0 || availableWords.length < 5) && !isLoadingMore && (
              <motion.button
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                onClick={loadNextBatch}
                disabled={isLoadingMore}
                className="group flex items-center gap-4 px-10 py-5 bg-sky-500 rounded-2xl text-xl font-black text-white shadow-2xl shadow-sky-500/40 hover:bg-sky-400 transition-all hover:-translate-y-1 active:scale-95 disabled:opacity-50"
              >
                {availableWords.length === 0 ? "Unlock Next Level" : "Next Session"}
                <ChevronRight className="w-6 h-6 group-hover:translate-x-2 transition-transform" />
              </motion.button>
            )}

            {isLoadingMore && (
              <div className="flex flex-col items-center gap-4 py-8">
                <Loader2 className="w-10 h-10 text-sky-500 animate-spin" />
                <p className="text-sky-400 font-bold animate-pulse uppercase tracking-[0.2em] text-xs">
                  Generating AI Session...
                </p>
              </div>
            )}

            <div className="text-slate-500 text-[10px] font-black uppercase tracking-[0.3em] flex items-center gap-4">
              <span>{availableWords.length} in current library</span>
              <span className="w-1 h-1 bg-slate-700 rounded-full" />
              <span>{allWords.length} total words</span>
            </div>
          </div>
        )}
      </main>

      <footer className="mt-20 border-t border-white/5 py-16 px-6">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-10">
          <div className="flex items-center gap-4">
             <div className="p-3 bg-slate-900 rounded-2xl border border-white/5">
                <GraduationCap className="w-8 h-8 text-sky-500" />
             </div>
             <div>
                <p className="text-white font-bold">LexiFlow IELTS</p>
                <p className="text-xs text-slate-500">Your journey to band 9.0 starts here.</p>
             </div>
          </div>
          
          <div className="flex flex-wrap justify-center gap-10">
             <div className="text-center md:text-right">
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Mastered</p>
                <div className="flex flex-col items-end">
                  <p className="text-2xl font-black text-emerald-500">{progress.masteredIds.length}</p>
                </div>
             </div>
             <div className="text-center md:text-right">
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Studying</p>
                <p className="text-2xl font-black text-amber-500">{progress.learningIds.length}</p>
             </div>
             <div className="text-center md:text-right">
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Sync Status</p>
                <div className="flex items-center gap-2 text-right justify-end">
                   <p className={`text-[10px] font-black uppercase tracking-widest ${isSyncing ? 'text-sky-500 animate-pulse' : 'text-slate-500'}`}>
                     {isSyncing ? 'Saving...' : 'Synced'}
                   </p>
                   <div className={`w-1.5 h-1.5 rounded-full ${isSyncing ? 'bg-sky-500 animate-ping' : hasLoadedFromCloud ? 'bg-emerald-500' : 'bg-red-500'}`} />
                </div>
             </div>
          </div>
        </div>
        
        <div className="max-w-6xl mx-auto mt-12 pt-8 border-t border-white/5 flex justify-center">
           <button 
             onClick={handleReset}
             className={`flex items-center gap-2 px-6 py-2.5 text-[10px] font-black uppercase tracking-[0.2em] rounded-xl transition-all border ${
               isConfirmingReset 
                 ? 'bg-red-500 text-white border-red-400 shadow-lg shadow-red-500/20' 
                 : 'text-red-500/50 hover:text-red-500 hover:bg-red-500/10 border-red-500/10'
             }`}
           >
             <RotateCcw className={`w-3.5 h-3.5 ${isConfirmingReset ? 'animate-spin' : ''}`} />
             {isConfirmingReset ? "Click again to confirm" : "Reset All Progress"}
           </button>
        </div>
      </footer>
      
      <style>{`
        .perspective-2000 {
          perspective: 2000px;
        }
        .preserve-3d {
          transform-style: preserve-3d;
        }
        .backface-hidden {
          backface-visibility: hidden;
          -webkit-backface-visibility: hidden;
        }
        .no-scrollbar::-webkit-scrollbar {
          display: none;
        }
        .no-scrollbar {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(14, 165, 233, 0.2);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(14, 165, 233, 0.4);
        }
      `}</style>
    </div>
  );
}

