export const PLANS = {
  free:   { name: "Free",   rank: 0, price: { monthly: 0,   quarterly: 0,    yearly: 0 },
            dailyDownloads: 1,   quality: "480p",  dailyWatchMinutes: 60, ads: true,
            features: ["Limited premium videos", "480p streaming", "60 min watch time / day", "1 download per day", "Ads included"] },
  bronze: { name: "Bronze", rank: 1, price: { monthly: 99,  quarterly: 267,  yearly: 950 },
            dailyDownloads: 3,   quality: "720p",  dailyWatchMinutes: 0, ads: false,
            features: ["Bronze premium videos", "720p streaming", "Unlimited watch time", "3 downloads per day", "Ad-free"] },
  silver: { name: "Silver", rank: 2, price: { monthly: 199, quarterly: 537,  yearly: 1910 },
            dailyDownloads: 10,  quality: "1080p", dailyWatchMinutes: 0, ads: false,
            features: ["All videos + premium courses", "1080p streaming", "Unlimited watch time", "10 downloads per day", "Ad-free"] },
  gold:   { name: "Gold",   rank: 3, price: { monthly: 399, quarterly: 1077, yearly: 3830 },
            dailyDownloads: 999, quality: "4K",    dailyWatchMinutes: 0, ads: false,
            features: ["Everything unlocked + exclusive courses", "4K + fastest streaming", "Priority content access", "Unlimited downloads", "Ad-free"] },
};
export const PERIOD_DAYS = { monthly: 30, quarterly: 90, yearly: 365 };
