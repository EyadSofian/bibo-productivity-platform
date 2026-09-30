# تسليم: تشغيل LiveKit على سيرفر Engosoft الخاص (VPS)

> **لمن هذا الملف:** الشخص الذي سيجهّز السيرفر.
> **الهدف:** تشغيل خادم الفيديو LiveKit وخدمة التسجيل Egress على سيرفرنا بدل LiveKit Cloud، حتى يعمل البث المباشر والتسجيل **بدون حدّ للدقائق**، ثم تحويل تطبيق Engosoft إليه دون أي تعديل في الكود.
> **المدة المتوقعة:** من ساعتين إلى أربع ساعات، شاملة الاختبار.

---

## 1. الصورة الكاملة

```
جهاز الموظف (Windows)  ──WebRTC──▶  LiveKit على سيرفرنا  ◀──WebRTC──  متصفح المدير
                                          │
                                          ▼
                                  Egress (التسجيل)
                                          │  يرفع ملفات MP4 مباشرة
                                          ▼
                               تخزين Railway (screen-recordings)
                                          ▲
                                          │  يتحقق من الملفات ويشغّلها
                               تطبيق Engosoft على Railway
```

- **تطبيق Engosoft** (الـ backend على Railway) لا يمرّر أي فيديو. هو فقط يصدر مفاتيح دخول (tokens) ويطلب بدء التسجيل وإيقافه.
- **LiveKit** ينقل الفيديو بين جهاز الموظف ومتصفح المدير.
- **Egress** يسجّل شاشة الموظف كملفات MP4 كل 5 دقائق ويرفعها **مباشرة على تخزين Railway**. بيانات التخزين يرسلها التطبيق مع كل طلب تسجيل، فلا تُحفَظ على السيرفر.
- التطبيق **لا يستخدم webhooks** من LiveKit، فلا حاجة لإعدادها.

## 2. مواصفات السيرفر (مؤكدة)

| البند | القيمة |
|---|---|
| Hostname | `NLDW4-3-06-26` |
| النظام | Ubuntu 24.04.4 LTS (kernel 6.8, x86_64) |
| المعالج | AMD EPYC 9355P، 32 نواة / 64 thread |
| الذاكرة | 125 GiB (+47 GiB swap) |
| القرص | 878 GB ext4 |

هذه المواصفات تكفي مئات البثّ والتسجيلات المتزامنة. التسجيلات لا تُخزَّن على هذا السيرفر، بل تُرفع على Railway.

## 3. قبل البدء: أشياء يجب معرفتها

1. **هل على السيرفر خدمات أخرى؟** شغّل الأمر التالي واحتفظ بالنتيجة:
   ```bash
   sudo ss -tulpn | sort -k5
   docker ps 2>/dev/null
   ```
   - إذا كان المنفذ **443** مستخدمًا (مثلًا nginx أو Caddy لموقع آخر)، اتبع **الخيار ب** في القسم 6.
   - يجب أن تكون المنافذ `7880` و`7881` و`3478` و`5349` و`6379`، والنطاق `50000–60000/udp`، **غير مستخدمة**.
2. **لا تُعطّل أي خدمة موجودة.** إذا ظهر تعارض لم يغطّه هذا الملف، توقف واسأل.
3. **لا تكتب أي مفتاح أو كلمة سر في هذا الملف أو في Git.** المفاتيح توضع فقط في ملفات الإعداد على السيرفر وفي متغيرات Railway.

القيم التي ستستخدمها في الأوامر:

| الاسم | مثال | يأتي من |
|---|---|---|
| `<VPS_IP>` | `203.0.113.10` | عنوان IP العام للسيرفر |
| `<LIVE_DOMAIN>` | `live.engosoft.com` | الدومين الفرعي (القسم 4) |
| `<TURN_DOMAIN>` | `turn.engosoft.com` | دومين فرعي ثانٍ لخدمة TURN (القسم 4) |
| `<API_KEY>` / `<API_SECRET>` | تُولَّد في القسم 7 | تبقى على السيرفر وفي Railway فقط |

## 4. الدومين (DNS)

أنشئ سجلَّين من نوع **A** عند مزوّد الدومين:

| الاسم | النوع | القيمة |
|---|---|---|
| `live` | A | `<VPS_IP>` |
| `turn` | A | `<VPS_IP>` |

> **مهم جدًا إن كان الدومين على Cloudflare:** اجعل السجلَّين **DNS only (سحابة رمادية)**. وضع البروكسي (السحابة البرتقالية) يمنع WebRTC وTURN تمامًا.

تحقّق قبل المتابعة (يجب أن يظهر `<VPS_IP>`):
```bash
dig +short <LIVE_DOMAIN>
dig +short <TURN_DOMAIN>
```

## 5. الجدار الناري (Firewall)

افتح المنافذ على السيرفر، **وفي لوحة المزوّد أيضًا** إن كان لديه جدار ناري خاص:

| المنفذ | البروتوكول | الاستخدام |
|---|---|---|
| 80 | TCP | إصدار شهادة HTTPS (Let's Encrypt) |
| 443 | TCP | اتصال التطبيق والمتصفح الآمن (wss) |
| 7881 | TCP | فيديو عبر TCP عندما يُحجب UDP |
| 3478 | UDP | TURN للشبكات المقيّدة |
| 5349 | TCP | TURN عبر TLS للشبكات المقيّدة جدًا (شبكات الشركات) |
| 50000–60000 | UDP | الفيديو (المسار الأساسي) |

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 50000:60000/udp
sudo ufw status
```

> إذا كان `ufw` غير مفعّل، **لا تفعّله** قبل التأكد من السماح بمنفذ SSH (عادة `sudo ufw allow OpenSSH`)، وإلا ستُقفَل خارج السيرفر.

**لا تفتح** المنفذ `6379` (Redis) ولا `7880` للعالم؛ يبقيان داخليَّين.

## 6. شهادة HTTPS والبروكسي على المنفذ 443

LiveKit يستمع داخليًا على `7880`. نحتاج شيئًا على 443 يقدّم شهادة HTTPS ويمرّر الاتصال إليه.

### الخيار أ: المنفذ 443 غير مستخدم (الأبسط)

استخدم Caddy؛ يصدر الشهادة ويجدّدها تلقائيًا.

```bash
sudo apt update && sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
<LIVE_DOMAIN> {
    reverse_proxy 127.0.0.1:7880
}
EOF
sudo systemctl reload caddy
```

خدمة TURN تحتاج شهادة لـ `<TURN_DOMAIN>`. أضف الدومين إلى Caddy ليصدر شهادته، ثم تُنسخ ملفاتها إلى LiveKit في القسم 7.3:

```bash
sudo tee -a /etc/caddy/Caddyfile >/dev/null <<'EOF'
<TURN_DOMAIN> {
    respond "ok"
}
EOF
sudo systemctl reload caddy
# مكان الشهادات بعد إصدارها:
sudo ls /var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<TURN_DOMAIN>/
```

### الخيار ب: المنفذ 443 مستخدم بواسطة nginx لموقع آخر

أضف موقعًا جديدًا في nginx بدل Caddy (لا تغيّر المواقع الموجودة):

```nginx
# /etc/nginx/sites-available/livekit
server {
    listen 443 ssl http2;
    server_name <LIVE_DOMAIN>;
    ssl_certificate     /etc/letsencrypt/live/<LIVE_DOMAIN>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<LIVE_DOMAIN>/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot certonly --nginx -d <LIVE_DOMAIN> -d <TURN_DOMAIN>
sudo ln -s /etc/nginx/sites-available/livekit /etc/nginx/sites-enabled/livekit
sudo nginx -t && sudo systemctl reload nginx
```

شهادة TURN ستكون في `/etc/letsencrypt/live/<LIVE_DOMAIN>/` (نفس الشهادة تغطي الدومينين).

## 7. تثبيت LiveKit وEgress وRedis

### 7.1 Docker

```bash
docker --version || (curl -fsSL https://get.docker.com | sudo sh)
sudo mkdir -p /opt/livekit && cd /opt/livekit
```

### 7.2 توليد المفاتيح

```bash
docker run --rm livekit/livekit-server generate-keys
```

احتفظ بالناتج (`API Key` و`API Secret`) في مكان آمن؛ ستحتاجه في هذا القسم وفي القسم 9. **لا ترسله في دردشة ولا تضعه في Git.**

### 7.3 إعداد LiveKit: `/opt/livekit/livekit.yaml`

```yaml
port: 7880
bind_addresses:
  - "127.0.0.1"     # يصل إليه البروكسي فقط
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
redis:
  address: 127.0.0.1:6379
keys:
  <API_KEY>: <API_SECRET>
turn:
  enabled: true
  domain: <TURN_DOMAIN>
  udp_port: 3478
  tls_port: 5349
  cert_file: /certs/turn.crt
  key_file: /certs/turn.key
logging:
  level: info
```

انسخ شهادة TURN إلى مجلد ثابت (مسار الملفات من القسم 6):

```bash
sudo mkdir -p /opt/livekit/certs
# الخيار أ (Caddy):
#   sudo cp <مجلد شهادة TURN>/<TURN_DOMAIN>.crt /opt/livekit/certs/turn.crt
#   sudo cp <مجلد شهادة TURN>/<TURN_DOMAIN>.key /opt/livekit/certs/turn.key
# الخيار ب (certbot):
#   sudo cp /etc/letsencrypt/live/<LIVE_DOMAIN>/fullchain.pem /opt/livekit/certs/turn.crt
#   sudo cp /etc/letsencrypt/live/<LIVE_DOMAIN>/privkey.pem  /opt/livekit/certs/turn.key
sudo chmod 600 /opt/livekit/certs/turn.key
```

> الشهادات تتجدد كل 90 يومًا تقريبًا. أضف مهمة cron تنسخها وتعيد تشغيل LiveKit أسبوعيًا (القسم 10).

### 7.4 إعداد التسجيل: `/opt/livekit/egress.yaml`

```yaml
api_key: <API_KEY>
api_secret: <API_SECRET>
ws_url: wss://<LIVE_DOMAIN>
redis:
  address: 127.0.0.1:6379
health_port: 9090
log_level: info
```

لا تضع أي إعدادات تخزين هنا. تطبيق Engosoft يرسل بيانات تخزين Railway مع كل طلب تسجيل.

### 7.5 التشغيل: `/opt/livekit/docker-compose.yaml`

```yaml
services:
  redis:
    image: redis:7-alpine
    command: redis-server --bind 127.0.0.1 --save "" --appendonly no
    network_mode: host
    restart: unless-stopped

  livekit:
    image: livekit/livekit-server:latest
    command: --config /etc/livekit.yaml
    network_mode: host
    restart: unless-stopped
    depends_on: [redis]
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
      - ./certs:/certs:ro

  egress:
    image: livekit/egress:latest
    network_mode: host
    restart: unless-stopped
    depends_on: [redis, livekit]
    cap_add: [SYS_ADMIN]
    environment:
      EGRESS_CONFIG_FILE: /etc/egress.yaml
    volumes:
      - ./egress.yaml:/etc/egress.yaml:ro
```

> بعد نجاح الاختبار، **ثبّت أرقام الإصدارات** بدل `latest` (مثل `livekit/livekit-server:v1.x.y`) حتى لا يتغير شيء دون قصد عند إعادة التشغيل.

```bash
cd /opt/livekit
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs --tail=50 livekit egress
```

## 8. التحقق من السيرفر

```bash
# 1) الخادم يرد عبر HTTPS (يجب أن تظهر كلمة OK)
curl -s https://<LIVE_DOMAIN>/

# 2) Egress جاهز
curl -s http://127.0.0.1:9090/ ; echo

# 3) المنافذ تستمع
sudo ss -tulpn | grep -E ':(7880|7881|3478|5349|6379)\b'
```

من جهاز خارجي (ليس السيرفر)، تحقق من UDP وTURN:

- افتح <https://livekit.io/connection-test>، وأدخل `wss://<LIVE_DOMAIN>` ومفتاح دخول مؤقت. لإنشاء المفتاح:
  ```bash
  docker run --rm livekit/livekit-cli lk token create \
    --api-key <API_KEY> --api-secret <API_SECRET> \
    --join --room connection-test --identity tester --valid-for 1h
  ```
- يجب أن تنجح اختبارات: WebSocket، وWebRTC عبر UDP، وTCP، وTURN.

## 9. تحويل تطبيق Engosoft إلى السيرفر الجديد

**لا تغيير في الكود ولا في برنامج الموظف.** كل شيء عبر ثلاثة متغيرات في خدمة `web` على Railway.

1. **احتفظ بالقيم الحالية** (مفاتيح LiveKit Cloud) في مكان آمن؛ هي خطة الرجوع.
2. في Railway → مشروع `bibo-productivity-platform` → خدمة `web` → Variables، غيّر:

   | المتغير | القيمة الجديدة |
   |---|---|
   | `LIVEKIT_URL` | `wss://<LIVE_DOMAIN>` |
   | `LIVEKIT_API_KEY` | `<API_KEY>` |
   | `LIVEKIT_API_SECRET` | `<API_SECRET>` |

   **لا تغيّر** `MEDIA_PROVIDER` (يبقى `livekit`) ولا متغيرات `RECORDING_S3_*`.
3. أعد نشر خدمة `web` (Railway يعيد النشر تلقائيًا عند تغيير المتغيرات، أو من زر Redeploy).
4. التطبيق يعطي برنامج الموظف والمتصفح العنوان الجديد تلقائيًا مع كل جلسة، فلا حاجة لتحديث أي جهاز.

> التطبيق يرفض أي عنوان لا يبدأ بـ `wss://`. إذا ظهر خطأ عند التشغيل، تحقق من هذه النقطة أولًا.

## 10. التشغيل المستمر والمراقبة

1. **إعادة التشغيل التلقائي:** مفعّلة (`restart: unless-stopped`)، وDocker يبدأ مع السيرفر:
   ```bash
   sudo systemctl enable docker
   ```
2. **تجديد شهادة TURN أسبوعيًا** (عدّل المسارات حسب خيارك في القسم 6):
   ```bash
   sudo tee /etc/cron.weekly/livekit-certs >/dev/null <<'EOF'
   #!/bin/sh
   cp /etc/letsencrypt/live/<LIVE_DOMAIN>/fullchain.pem /opt/livekit/certs/turn.crt
   cp /etc/letsencrypt/live/<LIVE_DOMAIN>/privkey.pem  /opt/livekit/certs/turn.key
   chmod 600 /opt/livekit/certs/turn.key
   cd /opt/livekit && docker compose restart livekit
   EOF
   sudo chmod +x /etc/cron.weekly/livekit-certs
   ```
3. **مراقبة خارجية:** أضف فحصًا في UptimeRobot أو Better Stack (أو أي خدمة مشابهة) على `https://<LIVE_DOMAIN>/` كل دقيقة، مع تنبيه على الهاتف أو البريد عند التوقف.
4. **السجلات:**
   ```bash
   cd /opt/livekit && sudo docker compose logs -f --tail=100 livekit egress
   ```

## 11. خطة الرجوع (إذا توقف السيرفر)

1. في Railway، أعد المتغيرات الثلاثة إلى قيم LiveKit Cloud المحفوظة في الخطوة 9.1.
2. أعد نشر خدمة `web`.
3. يعود البث المباشر خلال دقائق. التسجيل على LiveKit Cloud يحتاج رصيد دقائق في خطتهم.

لا تحذف مشروع LiveKit Cloud؛ هو الاحتياطي.

## 12. اختبار القبول النهائي (يتم مع صاحب المشروع)

جهاز الاختبار: `a-refaat-MAR` (يجب أن يكون متصلًا وعلى إصدار 1.5.30 أو أحدث).

- [ ] من لوحة التحكم ← الموظفون ← الموظف ← **مباشر الآن**: يظهر الفيديو خلال أقل من 10 ثوانٍ.
- [ ] إيقاف البث ثم تشغيله مرة أخرى: يعمل.
- [ ] قفل شاشة الموظف: تظهر رسالة «البث متوقف مؤقتًا»، ويعود البث تلقائيًا بعد فتح القفل.
- [ ] خلال ساعات «تسجيل فيديو جلسة العمل» في سياسة المراقبة: يظهر مقطع حالته **جاهز** في تبويب «فيديو اليوم كامل» خلال 10 دقائق تقريبًا، ويعمل عند الضغط عليه.
- [ ] الضغط على تطبيق في تبويب «التطبيقات والمواقع» يشغّل الفيديو عند وقت استخدامه.
- [ ] `sudo docker compose logs egress` لا يُظهر أخطاء رفع إلى التخزين.
- [ ] إعادة تشغيل السيرفر بالكامل (`sudo reboot`): كل الخدمات ترجع وحدها، والبث يعمل بعدها.

للتحقق من التسجيل من قاعدة البيانات (يشغّله صاحب المشروع):
```bash
railway ssh --service Postgres psql -U postgres -d railway -Atc \
  "SELECT status, count(*), max(started_at) FROM recording_assets WHERE started_at > now()-interval '1 day' GROUP BY 1;"
```
النتيجة المطلوبة: صفوف بحالة `ready`.

## 13. أعطال شائعة

| العرض | السبب المحتمل | الحل |
|---|---|---|
| البث يبقى «جارٍ الاتصال» ثم يفشل | منافذ UDP مغلقة في جدار المزوّد | افتح `50000–60000/udp` و`3478/udp` في لوحة المزوّد |
| يعمل في البيت ولا يعمل في شبكة الشركة | الشبكة تحجب UDP | تأكد أن TURN على `5349/tcp` يعمل وأن شهادته صالحة |
| خطأ شهادة في المتصفح | الدومين على بروكسي Cloudflare أو الشهادة لم تصدر | اجعل السجل DNS only، وتحقق من Caddy أو certbot |
| التسجيل يفشل فورًا | Egress لا يصل إلى Redis أو مفاتيحه خاطئة | راجع `egress.yaml` وسجلات egress |
| التسجيل يفشل عند الرفع | السيرفر لا يصل إلى تخزين Railway | اختبر: `curl -I https://t3.storageapi.dev` من السيرفر |
| كل شيء توقف بعد إعادة تشغيل | Docker لا يبدأ تلقائيًا | `sudo systemctl enable --now docker` ثم `docker compose up -d` |

## 14. ملاحظات للفريق

- **الخصوصية:** التسجيل مُعلَن للموظف. Windows يعرض إطارًا أصفر حول الشاشة أثناء الالتقاط، وبرنامج BiBoTracking يعرض حالة التسجيل. لا تغيّر هذا السلوك.
- **لا صور شاشة:** المراقبة فيديو فقط (قرار المشروع). لا تفعّل أي ميزة لقطات أو thumbnails في LiveKit أو Egress.
- **الأمان:** المفاتيح موجودة فقط في `/opt/livekit/*.yaml` (صلاحيات root) وفي متغيرات Railway. ملفات الإعداد لا تُرفع إلى Git.
