/* ============================================================
   PATH: frontend/js/state.js  — v2
   PURPOSE: Single source of truth + question data
   ============================================================ */

const AppState = {
  interests:      [],
  mood:           null,
  roomId:         null,
  socketId:       null,
  isMatched:      false,
  isMuted:        false,
  noiseReduction: true,
  stream:         null,
  peerConnection: null,
  currentStep:    1,
  myRole:         null,   // 'A' or 'B'
  mySocketId:     null,
};

const INTERESTS = [
  'Coding', 'Gaming', 'Music', 'Movies', 'Anime', 'Tech',
  'Crypto', 'Fitness', 'Art', 'Startup', 'Night Talks',
  'Philosophy', 'Design', 'Books'
];

const MOODS = [
  { name: 'Chill',     sub: 'Easy going conversations' },
  { name: 'Deep Talk', sub: 'Get real about life'      },
  { name: 'Funny',     sub: 'Keep it light and laugh'  },
  { name: 'Debate',    sub: 'Friendly clash of views'  },
  { name: 'Study',     sub: 'Focus mode together'      },
  { name: 'Random',    sub: 'Anything goes'            },
];

// 50 icebreaker questions for the question system
const QUESTIONS = [
  "What's one thing you've been meaning to learn but keep putting off?",
  "If you could master any skill overnight, what would it be?",
  "What's the last thing that genuinely surprised you?",
  "What project have you been dreaming about but haven't started yet?",
  "What keeps you up at night — in a good way?",
  "If you had 6 months with no obligations, what would you build?",
  "What's the most underrated thing you've discovered recently?",
  "If you could go back 5 years and give yourself one piece of advice?",
  "What's a skill most people don't know you have?",
  "What's the best advice you've ever received?",
  "What's something you believe that most people would disagree with?",
  "What's a habit that's changed your life for the better?",
  "What does your ideal day look like?",
  "What's the most interesting rabbit hole you've gone down recently?",
  "What's something you've changed your mind about in the last year?",
  "If you could live anywhere in the world, where would it be and why?",
  "What's the biggest risk you've ever taken?",
  "What's something you're working on that excites you?",
  "If money wasn't a factor, what would you spend your time doing?",
  "What's the most meaningful compliment you've ever received?",
  "What's something you think everyone should try at least once?",
  "What would you do differently if you knew you couldn't fail?",
  "What's a book or podcast that genuinely changed how you think?",
  "What does success look like to you — personally, not professionally?",
  "What's the most important lesson you've learned from a failure?",
  "If you could have a conversation with anyone alive today, who would it be?",
  "What's something you're genuinely proud of that most people don't know about?",
  "What's your favourite way to spend a weekend?",
  "What's a small thing that brings you a lot of joy?",
  "What's something you're curious about that you haven't explored yet?",
  "What did you want to be when you grew up — and did it happen?",
  "What's the craziest thing on your bucket list?",
  "What's a challenge you're currently working through?",
  "What's something you wish you had started earlier?",
  "If you could delete one app from your phone forever, which one?",
  "What's the best decision you made in the last 12 months?",
  "What's something that makes you feel genuinely alive?",
  "How do you usually recharge after a tough week?",
  "What's a rule you live by?",
  "What's the most creative thing you've ever done?",
  "What's something you're learning right now?",
  "If you could fix one thing about the world, what would it be?",
  "What's the strangest or most unexpected friendship you've made?",
  "What's something most people misunderstand about you?",
  "What's a moment in your life you'd relive if you could?",
  "What's something you used to think was important that you no longer care about?",
  "What does your morning routine look like?",
  "What's one thing you want to do before the end of this year?",
  "What's the kindest thing a stranger has ever done for you?",
  "If you had to describe yourself in three words, what would they be?",
];

// Legacy alias for old code
const ICEBREAKERS = QUESTIONS;

function saveRoomInfo(roomId, socketId) {
    AppState.roomId = roomId;
    AppState.socketId = socketId;
    sessionStorage.setItem('whisper_roomId', roomId);
}

function saveStream(stream) { AppState.stream = stream; }

function toggleMute() {
    AppState.isMuted = !AppState.isMuted;
    if (AppState.stream) {
        AppState.stream.getAudioTracks().forEach(t => { t.enabled = !AppState.isMuted; });
    }
    return AppState.isMuted;
}

function persistPreferences() {
    sessionStorage.setItem('whisper_interests', JSON.stringify(AppState.interests));
    sessionStorage.setItem('whisper_mood', AppState.mood || '');
    sessionStorage.setItem('whisper_roomId', AppState.roomId || '');
}

function loadPersistedPreferences() {
    const r = sessionStorage.getItem('whisper_roomId');
    const i = sessionStorage.getItem('whisper_interests');
    const m = sessionStorage.getItem('whisper_mood');
    if (r) AppState.roomId = r;
    if (i) AppState.interests = JSON.parse(i);
    if (m) AppState.mood = m;
}

function clearPersistedPreferences() {
    sessionStorage.removeItem('whisper_roomId');
    sessionStorage.removeItem('whisper_interests');
    sessionStorage.removeItem('whisper_mood');
}

function resetState() {
    AppState.interests = []; AppState.mood = null; AppState.roomId = null;
    AppState.isMatched = false; AppState.isMuted = false;
    AppState.stream = null; AppState.peerConnection = null;
    AppState.currentStep = 1; AppState.myRole = null;
}
