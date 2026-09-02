import React, { useState } from 'react';
import { Sparkles, Key, RefreshCw, Trash2, Mail, ShieldAlert, Check, Copy, AlertCircle } from 'lucide-react';
import { UserTier, QuotaInfo } from '../types.js';

interface AccountLifecycleTabProps {
  currentTier: UserTier;
  quota: QuotaInfo | null;
  onRefreshQuota: () => void;
  onTierChange: (tier: UserTier) => void;
}

export const AccountLifecycleTab: React.FC<AccountLifecycleTabProps> = ({
  currentTier,
  quota,
  onRefreshQuota,
  onTierChange,
}) => {
  // Token Minter State
  const [mintUserId, setMintUserId] = useState('developer_tester_1');
  const [mintTier, setMintTier] = useState<UserTier>(currentTier);
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);

  // Password Reset State
  const [resetEmail, setResetEmail] = useState('victorkirui.dev@gmail.com');
  const [resetStatus, setResetStatus] = useState<string | null>(null);

  // Deletion State
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Action Handlers
  const handleMintToken = async () => {
    try {
      const res = await fetch('/v1/auth/mint-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: mintTier, userId: mintUserId }),
      });
      const data = await res.json() as { success?: boolean; token?: string };
      if (data.success) {
        setMintedToken(data.token);
      }
    } catch (err) {
      console.error('Minting failed', err);
    }
  };

  const handleResetQuota = async (all = false) => {
    try {
      await fetch('/v1/quota/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer remindly_test_${currentTier}_playground_user`,
        },
        body: JSON.stringify({ all, userId: 'playground_user' }),
      });
      onRefreshQuota();
    } catch (err) {
      console.error('Reset quota failed', err);
    }
  };

  const handlePasswordReset = async () => {
    try {
      const res = await fetch('/v1/account/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetEmail }),
      });
      const data = await res.json() as { message?: string };
      setResetStatus(data.message || 'Password reset email triggered.');
    } catch (err) {
      setResetStatus('Error triggering password reset.');
    }
  };

  const handleDeleteAccount = async () => {
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      return;
    }
    setIsDeleting(true);
    try {
      const res = await fetch('/v1/account/delete', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer remindly_test_${currentTier}_playground_user`,
        },
      });
      const data = await res.json() as { message?: string };
      setDeleteStatus(data.message || 'Account purged successfully');
      setDeleteConfirm(false);
    } catch (err) {
      setDeleteStatus('Failed to delete account.');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCopyToken = () => {
    if (!mintedToken) return;
    navigator.clipboard.writeText(mintedToken);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2000);
  };

  return (
    <div id="account-lifecycle-section" className="space-y-6">
      {/* Dev Token Minter */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-center gap-2 border-b border-gray-100 pb-3">
          <Key className="w-5 h-5 text-indigo-600" />
          <div>
            <h3 className="text-sm font-bold text-gray-900">Developer Token Minter</h3>
            <p className="text-xs text-gray-500">Generate signed development tokens with custom claims & tiers</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">User Identifier</label>
            <input
              type="text"
              value={mintUserId}
              onChange={(e) => setMintUserId(e.target.value)}
              className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-900 focus:outline-none focus:border-indigo-500 font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Assigned Tier</label>
            <select
              value={mintTier}
              onChange={(e) => setMintTier(e.target.value as UserTier)}
              className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-900 focus:outline-none focus:border-indigo-500"
            >
              <option value="free">Free Tier (Local Rule AI)</option>
              <option value="premium">Premium Tier (Gemini AI Engine)</option>
            </select>
          </div>

          <div className="flex items-end">
            <button
              onClick={handleMintToken}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-3 rounded-lg text-xs transition shadow-xs cursor-pointer"
            >
              Mint Token Payload
            </button>
          </div>
        </div>

        {mintedToken && (
          <div className="p-3 bg-gray-50 rounded-lg border border-gray-200 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-600 font-medium">Generated Bearer Token:</span>
              <button
                onClick={handleCopyToken}
                className="flex items-center gap-1 text-indigo-600 hover:text-indigo-700 text-xs font-medium cursor-pointer"
              >
                {copiedToken ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedToken ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <div className="font-mono text-xs text-emerald-400 break-all bg-gray-900 p-2.5 rounded-lg border border-gray-800">
              {mintedToken}
            </div>
          </div>
        )}
      </div>

      {/* Quota Controls */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-center justify-between border-b border-gray-100 pb-3">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-5 h-5 text-indigo-600" />
            <div>
              <h3 className="text-sm font-bold text-gray-900">Sliding-Window Quota Controls</h3>
              <p className="text-xs text-gray-500">Current tier capacity & window resets</p>
            </div>
          </div>

          <button
            onClick={() => handleResetQuota(false)}
            className="px-3 py-1.5 rounded-lg bg-white hover:bg-gray-50 text-xs text-gray-700 border border-gray-200 shadow-xs transition cursor-pointer"
          >
            Reset My Quota
          </button>
        </div>

        {quota && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="p-3.5 rounded-lg bg-gray-50 border border-gray-200">
              <span className="text-gray-400 uppercase text-[10px] font-bold tracking-wider">Remaining Quota</span>
              <div className="text-lg font-bold text-indigo-700 mt-0.5">{quota.remaining} / {quota.limit}</div>
            </div>
            <div className="p-3.5 rounded-lg bg-gray-50 border border-gray-200">
              <span className="text-gray-400 uppercase text-[10px] font-bold tracking-wider">Window Size</span>
              <div className="text-lg font-bold text-gray-900 mt-0.5">{quota.windowSizeSeconds / 60} minutes</div>
            </div>
            <div className="p-3.5 rounded-lg bg-gray-50 border border-gray-200">
              <span className="text-gray-400 uppercase text-[10px] font-bold tracking-wider">Resets In</span>
              <div className="text-lg font-bold text-amber-600 mt-0.5">{quota.resetInSeconds}s</div>
            </div>
          </div>
        )}
      </div>

      {/* Account Operations & GDPR Deletion */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Password Reset */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-xs space-y-4">
          <div className="flex items-center gap-2 border-b border-gray-100 pb-3">
            <Mail className="w-5 h-5 text-indigo-600" />
            <h3 className="text-sm font-bold text-gray-900">Password Reset Flow</h3>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Registered Email</label>
            <input
              type="email"
              value={resetEmail}
              onChange={(e) => setResetEmail(e.target.value)}
              className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-900 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <button
            onClick={handlePasswordReset}
            className="w-full bg-white hover:bg-gray-50 text-gray-800 font-semibold py-2 px-3 rounded-lg text-xs transition border border-gray-200 shadow-xs cursor-pointer"
          >
            Dispatch Password Reset Email
          </button>

          {resetStatus && (
            <div className="text-xs text-emerald-800 bg-emerald-50 p-2.5 rounded-lg border border-emerald-200">
              {resetStatus}
            </div>
          )}
        </div>

        {/* GDPR Account Deletion */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-xs space-y-4">
          <div className="flex items-center gap-2 border-b border-gray-100 pb-3 text-rose-600">
            <ShieldAlert className="w-5 h-5" />
            <h3 className="text-sm font-bold text-gray-900">GDPR Account Deletion</h3>
          </div>

          <p className="text-xs text-gray-500 leading-relaxed">
            Permanently purges all user extractions, in-memory capture history, and Firestore documents.
          </p>

          <button
            onClick={handleDeleteAccount}
            disabled={isDeleting}
            className={`w-full font-semibold py-2 px-3 rounded-lg text-xs transition cursor-pointer ${
              deleteConfirm
                ? 'bg-rose-600 hover:bg-rose-700 text-white animate-pulse'
                : 'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200'
            }`}
          >
            {deleteConfirm ? 'Confirm Permanent Purge' : 'Delete Account & Purge Captures'}
          </button>

          {deleteStatus && (
            <div className="text-xs text-rose-800 bg-rose-50 p-2.5 rounded-lg border border-rose-200">
              {deleteStatus}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
