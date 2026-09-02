import React, { useState } from 'react';
import { ShieldCheck, Copy, Check, Terminal, Code2, Smartphone } from 'lucide-react';

export const AndroidKotlinTab: React.FC = () => {
  const [activeSnippet, setActiveSnippet] = useState<'service' | 'models' | 'interceptor' | 'repo' | 'viewmodel'>('service');
  const [copied, setCopied] = useState(false);

  const snippets = {
    service: `// RemindlyApiService.kt
package com.remindly.network

import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.Response
import retrofit2.http.*

interface RemindlyApiService {
    @Multipart
    @POST("/v1/extract-data")
    suspend fun extractReminder(
        @Header("Idempotency-Key") idempotencyKey: String? = null,
        @Header("X-User-Tier") tier: String? = null,
        @Part("text") text: RequestBody? = null,
        @Part("url") url: RequestBody? = null,
        @Part image: MultipartBody.Part? = null
    ): Response<ExtractionResponse>

    @GET("/v1/quota")
    suspend fun getQuota(): Response<QuotaResponse>

    @GET("/v1/items")
    suspend fun getCapturedItems(
        @Query("limit") limit: Int = 50
    ): Response<ItemsResponse>
}`,

    models: `// RemindlyModels.kt
package com.remindly.network.models

import com.google.gson.annotations.SerializedName

enum class ReminderCategory {
    MEETING, BILL_PAYMENT, DEADLINE, EVENT, TASK, APPOINTMENT, SUBSCRIPTION, TRAVEL, OTHER
}

data class ExtractionResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("data") val data: ExtractedReminderData,
    @SerializedName("quota") val quota: QuotaInfo,
    @SerializedName("metadata") val metadata: ExtractionMetadata,
    @SerializedName("error") val error: String? = null
)

data class ExtractedReminderData(
    @SerializedName("title") val title: String,
    @SerializedName("summary") val summary: String?, // Null in Free Tier, Populated in Premium Tier
    @SerializedName("category") val category: ReminderCategory,
    @SerializedName("deadline") val deadline: String?, // ISO-8601 UTC
    @SerializedName("eventDate") val eventDate: String?, // ISO-8601 UTC
    @SerializedName("organization") val organization: String?,
    @SerializedName("url") val url: String?,
    @SerializedName("strategy") val strategy: String,
    @SerializedName("tier") val tier: String,
    @SerializedName("actionableItems") val actionableItems: List<String>? = null
)

data class QuotaInfo(
    @SerializedName("limit") val limit: Int,
    @SerializedName("remaining") val remaining: Int,
    @SerializedName("resetInSeconds") val resetInSeconds: Int,
    @SerializedName("tier") val tier: String
)

data class ExtractionMetadata(
    @SerializedName("requestId") val requestId: String,
    @SerializedName("processingTimeMs") val processingTimeMs: Long,
    @SerializedName("cached") val cached: Boolean,
    @SerializedName("persistedToFirebase") val persistedToFirebase: Boolean
)`,

    interceptor: `// AuthAndIdempotencyInterceptor.kt
package com.remindly.network

import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.Response
import java.util.UUID

class AuthAndIdempotencyInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val builder = original.newBuilder()

        // 1. Inject Firebase Auth Token
        val user = FirebaseAuth.getInstance().currentUser
        if (user != null) {
            val tokenResult = runBlocking { user.getIdToken(false).await() }
            tokenResult.token?.let { idToken ->
                builder.addHeader("Authorization", "Bearer $idToken")
            }
        }

        // 2. Inject Idempotency-Key if not provided
        if (original.header("Idempotency-Key") == null && original.method == "POST") {
            builder.addHeader("Idempotency-Key", UUID.randomUUID().toString())
        }

        // 3. Inject Current Device ISO Date Context (enables precise relative resolution)
        if (original.header("X-Client-Date") == null) {
            builder.addHeader("X-Client-Date", java.time.Instant.now().toString())
        }

        // 4. Inject Device Timezone (e.g. ZoneId.systemDefault().id)
        if (original.header("X-User-Timezone") == null) {
            builder.addHeader("X-User-Timezone", java.time.ZoneId.systemDefault().id)
        }

        return chain.proceed(builder.build())
    }
}`,

    repo: `// RemindlyRepository.kt
package com.remindly.data

import com.remindly.network.RemindlyApiService
import com.remindly.network.models.ExtractedReminderData
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class RemindlyRepository @Inject constructor(
    private val apiService: RemindlyApiService
) {
    suspend fun extractReminder(
        text: String?,
        url: String?,
        imageFile: File?,
        tier: String = "premium"
    ): Result<ExtractedReminderData> = withContext(Dispatchers.IO) {
        try {
            val textPart = text?.toRequestBody("text/plain".toMediaTypeOrNull())
            val urlPart = url?.toRequestBody("text/plain".toMediaTypeOrNull())
            
            val imagePart = imageFile?.let { file ->
                val requestFile = file.asRequestBody("image/jpeg".toMediaTypeOrNull())
                MultipartBody.Part.createFormData("image", file.name, requestFile)
            }

            val response = apiService.extractReminder(
                tier = tier,
                text = textPart,
                url = urlPart,
                image = imagePart
            )

            if (response.isSuccessful && response.body()?.success == true) {
                Result.success(response.body()!!.data)
            } else {
                val errorMsg = response.errorBody()?.string() ?: "Extraction error"
                Result.failure(Exception(errorMsg))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}`,

    viewmodel: `// ExtractionViewModel.kt
package com.remindly.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.remindly.data.RemindlyRepository
import com.remindly.network.models.ExtractedReminderData
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject

sealed class ExtractionUiState {
    object Idle : ExtractionUiState()
    object Loading : ExtractionUiState()
    data class Success(val reminder: ExtractedReminderData) : ExtractionUiState()
    data class Error(val message: String) : ExtractionUiState()
}

@HiltViewModel
class ExtractionViewModel @Inject constructor(
    private val repository: RemindlyRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow<ExtractionUiState>(ExtractionUiState.Idle)
    val uiState = _uiState.asStateFlow()

    fun processContent(text: String?, url: String?, imageFile: File?, isPremium: Boolean) {
        viewModelScope.launch {
            _uiState.value = ExtractionUiState.Loading
            val tier = if (isPremium) "premium" else "free"
            
            val result = repository.extractReminder(text, url, imageFile, tier)
            result.onSuccess { reminder ->
                _uiState.value = ExtractionUiState.Success(reminder)
            }.onFailure { error ->
                _uiState.value = ExtractionUiState.Error(error.localizedMessage ?: "Failed to extract")
            }
        }
    }
}`
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(snippets[activeSnippet]);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div id="android-kotlin-section" className="space-y-6">
      <div className="bg-white border border-gray-200 p-5 rounded-xl shadow-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-indigo-600" />
            <h2 className="text-base font-bold text-gray-900">Android Kotlin SDK Integration</h2>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Production-grade Retrofit, Coroutines, and OkHttp client snippets ready for mobile integration.
          </p>
        </div>

        <button
          id="copy-snippet-btn"
          type="button"
          onClick={handleCopy}
          className="flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-xs font-semibold text-white shadow-xs transition cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-white" />
              <span>Copied Code</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy Snippet</span>
            </>
          )}
        </button>
      </div>

      {/* Snippet Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-gray-200 pb-2">
        {[
          { id: 'service', label: '1. Retrofit Service' },
          { id: 'models', label: '2. Kotlin Models' },
          { id: 'interceptor', label: '3. OkHttp Interceptor' },
          { id: 'repo', label: '4. Repository' },
          { id: 'viewmodel', label: '5. Jetpack ViewModel' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSnippet(tab.id as any)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
              activeSnippet === tab.id
                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200 font-semibold'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Code Display */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden shadow-xs">
        <div className="flex items-center justify-between px-4 py-2.5 bg-gray-950 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Code2 className="w-4 h-4 text-indigo-400" />
            <span className="text-xs font-mono text-gray-300">
              {activeSnippet === 'service' && 'RemindlyApiService.kt'}
              {activeSnippet === 'models' && 'RemindlyModels.kt'}
              {activeSnippet === 'interceptor' && 'AuthAndIdempotencyInterceptor.kt'}
              {activeSnippet === 'repo' && 'RemindlyRepository.kt'}
              {activeSnippet === 'viewmodel' && 'ExtractionViewModel.kt'}
            </span>
          </div>
          <span className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">
            Kotlin / Android
          </span>
        </div>
        <div className="p-4 overflow-x-auto max-h-[500px]">
          <pre className="text-xs font-mono text-emerald-400 leading-relaxed">
            {snippets[activeSnippet]}
          </pre>
        </div>
      </div>
    </div>
  );
};
