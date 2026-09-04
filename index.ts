import { createClient } from '@supabase/supabase-js';

// Définition des variables d'environnement
export interface Env {
  FEDAPAY_SECRET_KEY: string;
  FEDAPAY_WEBHOOK_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    // --- 1. ENDPOINT : CRÉER UN PAIEMENT (POST /create-payment) ---
    if (url.pathname === "/create-payment" && request.method === "POST") {
      try {
        const { userId, forfait, montant } = await request.json() as any;

        // Étape A : Créer la transaction chez FedaPay
        const fedapayRes = await fetch("https://api.fedapay.com/v1/transactions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.FEDAPAY_SECRET_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            amount: montant,
            currency: { iso: "XOF" },
            description: `Abonnement ${forfait} PermisBJ`,
            // URL qui sera ouverte après le paiement pour revenir dans l'app
            callback_url: "permisbj://payment-callback?status=success",
            customer: { 
                firstname: "Utilisateur", 
                lastname: userId, 
                email: `${userId}@permisbj.app` 
            }
          })
        });

        if (!fedapayRes.ok) throw new Error("Erreur FedaPay lors de la création");
        
        const transaction = await fedapayRes.json() as any;
        const transactionId = transaction.v1_transaction.id;

        // Étape B : Enregistrer la transaction "En attente" dans Supabase
        await supabase.from('subscriptions').insert({
          user_id: userId,
          transaction_id: transactionId.toString(),
          forfait: forfait,
          status: 'pending'
        });

        // Étape C : Générer le token sécurisé pour obtenir l'URL de paiement
        const tokenRes = await fetch(`https://api.fedapay.com/v1/transactions/${transactionId}/token`, {
          method: "POST",
          headers: { 
            "Authorization": `Bearer ${env.FEDAPAY_SECRET_KEY}`,
            "Content-Type": "application/json"
          }
        });
        
        const tokenData = await tokenRes.json() as any;

        // On renvoie l'URL finale à l'application Android
        return new Response(JSON.stringify({ paymentUrl: tokenData.url }), {
          headers: { "Content-Type": "application/json" }
        });

      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // --- 2. ENDPOINT : WEBHOOK (POST /webhook) ---
    // Appelé automatiquement par FedaPay quand le client a fini de payer
    if (url.pathname === "/webhook" && request.method === "POST") {
      const signature = request.headers.get("X-FEDAPAY-SIGNATURE");
      if (!signature) return new Response("No signature", { status: 400 });

      try {
        const event = await request.json() as any;
        const transactionData = event.entity;
        const eventName = event.name; // "transaction.approved" ou "transaction.declined"

        if (eventName === "transaction.approved") {
          // 1. Récupérer le type de forfait dans Supabase
          const { data: sub } = await supabase.from('subscriptions')
            .select('forfait')
            .eq('transaction_id', transactionData.id.toString())
            .single();

          // 2. Calculer la date d'expiration (30 jours ou 365 jours)
          const days = sub?.forfait === "premium_yearly" ? 365 : 30;
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + days);

          // 3. Valider l'abonnement dans la base de données
          await supabase.from('subscriptions')
            .update({ 
                status: 'active', 
                expires_at: expiresAt.toISOString() 
            })
            .eq('transaction_id', transactionData.id.toString());
            
        } else if (eventName === "transaction.declined") {
          await supabase.from('subscriptions')
            .update({ status: 'failed' })
            .eq('transaction_id', transactionData.id.toString());
        }

        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response("Error processing webhook", { status: 500 });
      }
    }

    // --- 3. ENDPOINT : VÉRIFIER STATUT (GET /subscription-status) ---
    if (url.pathname === "/subscription-status" && request.method === "GET") {
      const userId = url.searchParams.get("userId");
      if (!userId) return new Response("Missing userId", { status: 400 });

      // On cherche un abonnement actif et non expiré
      const { data } = await supabase
        .from('subscriptions')
        .select('status, expires_at')
        .eq('user_id', userId)
        .eq('status', 'active')
        .gt('expires_at', new Date().toISOString())
        .order('expires_at', { ascending: false })
        .limit(1);

      const isActive = data && data.length > 0;
      
      return new Response(JSON.stringify({
        isPremium: isActive,
        expiresAt: isActive ? data[0].expires_at : null
      }), { 
        headers: { "Content-Type": "application/json" } 
      });
    }

    return new Response("PermisBJ Backend is Running", { status: 200 });
  }
};
