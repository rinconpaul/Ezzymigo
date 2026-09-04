import React, { useState, useEffect, useId } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Calendar, Globe, Check, ChevronDown, Sparkles } from 'lucide-react';
import { UserOccasionPreferences } from '../types';
import {
  SUPPORTED_REGIONS,
  TRADITION_SOURCES,
  getRegionalOccasions,
  getTraditionOccasions,
  getDefaultOccasionPreferences,
} from '../data/occasionsCatalog';

interface OccasionsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const OccasionsModal: React.FC<OccasionsModalProps> = ({ isOpen, onClose }) => {
  const regionSelectId = useId();
  const [preferences, setPreferences] = useState<UserOccasionPreferences>(() =>
    getDefaultOccasionPreferences('AU', 'ACT')
  );
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [lastSavedTime, setLastSavedTime] = useState<string | null>(null);

  // Load preferences when modal is opened
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    setIsLoading(true);

    fetch('/api/occasions/preferences')
      .then((res) => res.json())
      .then((data) => {
        if (!isMounted) return;
        if (data.preferences) {
          setPreferences(data.preferences);
        }
        setIsLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load occasion preferences:', err);
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  // Persist updated preferences to backend
  const savePreferences = async (updated: UserOccasionPreferences) => {
    setPreferences(updated);
    setIsSaving(true);
    try {
      const res = await fetch('/api/occasions/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (res.ok) {
        setLastSavedTime('Saved');
        setTimeout(() => setLastSavedTime(null), 2500);
      }
    } catch (err) {
      console.error('Failed to save occasion preferences:', err);
    } finally {
      setIsSaving(false);
    }
  };

  // Region change handler
  const handleRegionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedRegionId = e.target.value;
    const regionOpt = SUPPORTED_REGIONS.find((r) => r.id === selectedRegionId);
    if (!regionOpt) return;

    const newCountry = regionOpt.countryCode;
    const newSubdiv = regionOpt.subdivisionCode;

    // Get regional occasions for new region and default them on if not set
    const regionalItems = getRegionalOccasions(newCountry, newSubdiv);
    const updatedOccasions = { ...preferences.occasions };
    for (const item of regionalItems) {
      if (updatedOccasions[item.id] === undefined) {
        updatedOccasions[item.id] = true;
      }
    }

    const updated: UserOccasionPreferences = {
      ...preferences,
      country: newCountry,
      subdivision: newSubdiv,
      occasions: updatedOccasions,
      updatedAt: new Date().toISOString(),
    };
    savePreferences(updated);
  };

  // Toggle individual occasion
  const handleToggleOccasion = (occasionId: string) => {
    const isCurrentlyChecked = preferences.occasions[occasionId] ?? false;
    const updated: UserOccasionPreferences = {
      ...preferences,
      occasions: {
        ...preferences.occasions,
        [occasionId]: !isCurrentlyChecked,
      },
      updatedAt: new Date().toISOString(),
    };
    savePreferences(updated);
  };

  // Toggle tradition source (multi-select)
  const handleToggleTradition = (traditionId: string) => {
    const isSelected = preferences.selectedTraditions.includes(traditionId);
    let newTraditions: string[];
    const updatedOccasions = { ...preferences.occasions };

    if (isSelected) {
      newTraditions = preferences.selectedTraditions.filter((id) => id !== traditionId);
    } else {
      newTraditions = [...preferences.selectedTraditions, traditionId];
      // When newly adding a tradition, default all its individual occasions to true
      const traditionItems = getTraditionOccasions(traditionId);
      for (const item of traditionItems) {
        if (updatedOccasions[item.id] === undefined) {
          updatedOccasions[item.id] = true;
        }
      }
    }

    const updated: UserOccasionPreferences = {
      ...preferences,
      selectedTraditions: newTraditions,
      occasions: updatedOccasions,
      updatedAt: new Date().toISOString(),
    };
    savePreferences(updated);
  };

  // Toggle all occasions for current region
  const handleToggleAllRegional = (enable: boolean) => {
    const regionalItems = getRegionalOccasions(preferences.country, preferences.subdivision);
    const updatedOccasions = { ...preferences.occasions };
    for (const item of regionalItems) {
      updatedOccasions[item.id] = enable;
    }
    const updated: UserOccasionPreferences = {
      ...preferences,
      occasions: updatedOccasions,
      updatedAt: new Date().toISOString(),
    };
    savePreferences(updated);
  };

  // Toggle all occasions for a tradition
  const handleToggleAllTradition = (traditionId: string, enable: boolean) => {
    const traditionItems = getTraditionOccasions(traditionId);
    const updatedOccasions = { ...preferences.occasions };
    for (const item of traditionItems) {
      updatedOccasions[item.id] = enable;
    }
    const updated: UserOccasionPreferences = {
      ...preferences,
      occasions: updatedOccasions,
      updatedAt: new Date().toISOString(),
    };
    savePreferences(updated);
  };

  // Current active region display
  const currentRegionId =
    SUPPORTED_REGIONS.find(
      (r) =>
        r.countryCode === preferences.country &&
        (r.subdivisionCode || undefined) === (preferences.subdivision || undefined)
    )?.id || 'AU-ACT';

  const regionalOccasions = getRegionalOccasions(preferences.country, preferences.subdivision);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-zinc-900/60 backdrop-blur-xs overflow-y-auto">
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.16 }}
            className="w-full max-w-2xl bg-white rounded-2xl shadow-xl border border-zinc-200 overflow-hidden flex flex-col my-auto max-h-[90vh]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="occasions-modal-title"
          >
            {/* Header */}
            <div className="p-4 sm:p-5 border-b border-zinc-200/90 flex items-start justify-between bg-zinc-50/70">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-zinc-900 text-white flex items-center justify-center">
                    <Calendar className="w-4 h-4" />
                  </div>
                  <h2 id="occasions-modal-title" className="text-base sm:text-lg font-bold text-zinc-900">
                    Occasions
                  </h2>
                  {lastSavedTime && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                      <Check className="w-3 h-3" />
                      {lastSavedTime}
                    </span>
                  )}
                </div>
                <p className="text-xs sm:text-sm text-zinc-600">
                  Choose the occasions you&apos;d like Ezzy to remember and anticipate.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 text-zinc-500 hover:text-zinc-800 hover:bg-zinc-200/60 rounded-lg transition-colors cursor-pointer"
                title="Close"
                aria-label="Close occasions dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Content Scroll Area */}
            <div className="p-4 sm:p-6 overflow-y-auto space-y-6 text-zinc-800">
              {/* Region Selector */}
              <div className="bg-zinc-50 rounded-xl p-3.5 sm:p-4 border border-zinc-200/80 space-y-2">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor={regionSelectId}
                    className="text-xs font-bold uppercase tracking-wider text-zinc-600 flex items-center gap-1.5"
                  >
                    <Globe className="w-3.5 h-3.5 text-zinc-500" />
                    Your region
                  </label>
                  <span className="text-[11px] text-zinc-500">Stored as your preference</span>
                </div>
                <div className="relative">
                  <select
                    id={regionSelectId}
                    value={currentRegionId}
                    onChange={handleRegionChange}
                    className="w-full appearance-none bg-white text-zinc-900 font-medium text-xs sm:text-sm px-3.5 py-2.5 rounded-lg border border-zinc-300 hover:border-zinc-400 focus:outline-hidden focus:ring-2 focus:ring-zinc-900 cursor-pointer shadow-2xs pr-9"
                  >
                    {SUPPORTED_REGIONS.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.displayName}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-zinc-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>

              {/* Popular Where You Live */}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-zinc-200 pb-2">
                  <div>
                    <h3 className="text-sm sm:text-base font-bold text-zinc-900">
                      Popular where you live
                    </h3>
                    <p className="text-xs text-zinc-500">
                      Appropriate to your selected region
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs">
                    <button
                      type="button"
                      onClick={() => handleToggleAllRegional(true)}
                      className="text-[11px] text-zinc-600 hover:text-zinc-900 font-medium px-2 py-0.5 rounded-md hover:bg-zinc-100 transition-colors"
                    >
                      Select all
                    </button>
                    <span className="text-zinc-300">|</span>
                    <button
                      type="button"
                      onClick={() => handleToggleAllRegional(false)}
                      className="text-[11px] text-zinc-600 hover:text-zinc-900 font-medium px-2 py-0.5 rounded-md hover:bg-zinc-100 transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  {regionalOccasions.map((occ) => {
                    const isChecked = preferences.occasions[occ.id] ?? false;
                    return (
                      <label
                        key={occ.id}
                        className={`flex items-start gap-2.5 p-2.5 rounded-xl border transition-all cursor-pointer select-none ${
                          isChecked
                            ? 'bg-zinc-50 border-zinc-300 shadow-2xs'
                            : 'bg-white border-zinc-200/70 hover:bg-zinc-50/50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleToggleOccasion(occ.id)}
                          className="mt-0.5 rounded-sm border-zinc-300 text-zinc-900 focus:ring-zinc-900 h-4 w-4 shrink-0 cursor-pointer"
                        />
                        <div className="space-y-0.5 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-xs sm:text-sm font-semibold text-zinc-900 leading-tight">
                              {occ.name}
                            </span>
                            {occ.defaultAnticipatoryMode === 'PRE_ONLY' ? (
                              <span className="text-[10px] text-zinc-600 bg-zinc-200/70 px-1.5 py-0.2 rounded-sm font-medium">
                                Awareness
                              </span>
                            ) : (
                              <span className="text-[10px] text-zinc-700 bg-zinc-200/70 px-1.5 py-0.2 rounded-sm font-medium flex items-center gap-0.5">
                                <Sparkles className="w-2.5 h-2.5 text-zinc-500" />
                                Heads-up & Check-in
                              </span>
                            )}
                          </div>
                          {occ.description && (
                            <p className="text-[11px] text-zinc-500 leading-snug line-clamp-2">
                              {occ.description}
                            </p>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Traditions & Calendars */}
              <div className="space-y-3 pt-2">
                <div className="border-b border-zinc-200 pb-2">
                  <h3 className="text-sm sm:text-base font-bold text-zinc-900">
                    Traditions & calendars
                  </h3>
                  <p className="text-xs text-zinc-500">
                    Select cultural or religious sources to include. Independent of your region.
                  </p>
                </div>

                {/* Tradition Multi-Select Pills */}
                <div className="flex flex-wrap gap-2 pt-1">
                  {TRADITION_SOURCES.map((source) => {
                    const isSelected = preferences.selectedTraditions.includes(source.id);
                    return (
                      <button
                        key={source.id}
                        type="button"
                        onClick={() => handleToggleTradition(source.id)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-zinc-900 text-white shadow-xs'
                            : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200/80 border border-zinc-200'
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3" />}
                        <span>{source.name}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Active Traditions Occasions List */}
                {preferences.selectedTraditions.length > 0 && (
                  <div className="space-y-4 pt-3">
                    {preferences.selectedTraditions.map((tradId) => {
                      const tradMeta = TRADITION_SOURCES.find((t) => t.id === tradId);
                      const occasions = getTraditionOccasions(tradId);
                      if (!tradMeta) return null;

                      return (
                        <div
                          key={tradId}
                          className="bg-zinc-50/80 rounded-xl p-3.5 border border-zinc-200/80 space-y-3"
                        >
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <div>
                              <h4 className="text-xs sm:text-sm font-bold text-zinc-900 flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-zinc-800" />
                                {tradMeta.name}
                              </h4>
                              <p className="text-[11px] text-zinc-500">{tradMeta.description}</p>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                              <button
                                type="button"
                                onClick={() => handleToggleAllTradition(tradId, true)}
                                className="text-[11px] text-zinc-600 hover:text-zinc-900 font-medium hover:underline"
                              >
                                Select all
                              </button>
                              <span className="text-zinc-300">|</span>
                              <button
                                type="button"
                                onClick={() => handleToggleAllTradition(tradId, false)}
                                className="text-[11px] text-zinc-600 hover:text-zinc-900 font-medium hover:underline"
                              >
                                Clear
                              </button>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {occasions.map((occ) => {
                              const isChecked = preferences.occasions[occ.id] ?? false;
                              return (
                                <label
                                  key={occ.id}
                                  className={`flex items-start gap-2.5 p-2 rounded-lg border transition-all cursor-pointer select-none ${
                                    isChecked
                                      ? 'bg-white border-zinc-300 shadow-2xs'
                                      : 'bg-zinc-100/60 border-zinc-200/60 text-zinc-500'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => handleToggleOccasion(occ.id)}
                                    className="mt-0.5 rounded-sm border-zinc-300 text-zinc-900 focus:ring-zinc-900 h-4 w-4 shrink-0 cursor-pointer"
                                  />
                                  <div className="space-y-0.5 min-w-0">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span
                                        className={`text-xs font-semibold leading-tight ${
                                          isChecked ? 'text-zinc-900' : 'text-zinc-600'
                                        }`}
                                      >
                                        {occ.name}
                                      </span>
                                      {occ.defaultAnticipatoryMode === 'PRE_ONLY' ? (
                                        <span className="text-[9px] text-zinc-600 bg-zinc-200/70 px-1.5 py-0.2 rounded-sm font-medium">
                                          Awareness
                                        </span>
                                      ) : (
                                        <span className="text-[9px] text-zinc-700 bg-zinc-200/70 px-1.5 py-0.2 rounded-sm font-medium">
                                          Heads-up & Check-in
                                        </span>
                                      )}
                                    </div>
                                    {occ.description && (
                                      <p className="text-[10px] text-zinc-500 leading-snug line-clamp-2">
                                        {occ.description}
                                      </p>
                                    )}
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="p-3.5 sm:p-4 border-t border-zinc-200 bg-zinc-50 flex items-center justify-between">
              <div className="text-xs text-zinc-500">
                {isSaving ? (
                  <span>Saving preferences...</span>
                ) : (
                  <span>Preferences saved automatically</span>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-white text-xs sm:text-sm font-medium rounded-lg transition-colors cursor-pointer shadow-2xs"
              >
                Done
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
