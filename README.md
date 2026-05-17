# WebP 변환기

WebP 파일을 iOS 사진앱에서 재생 가능한 형식(MP4 · JPEG)으로 변환하는 웹 앱입니다. 브라우저에서 모든 처리가 이루어지며 파일이 외부 서버로 전송되지 않습니다.

- **애니메이션 WebP → MP4** (H.264, iOS 호환) — WebCodecs API 사용
- **정지 WebP → JPEG** (품질 0.92) — Canvas API 사용
- 드래그 앤 드롭 · 다중 파일 일괄 처리 · ZIP 일괄 다운로드
- iOS Safari 우선 모바일 친화 UI

## 사용법

1. 페이지를 엽니다.
2. WebP 파일을 드롭존에 끌어다 놓거나 클릭해서 선택합니다.
3. 자동으로 애니메이션 / 정지 이미지를 판별해 변환합니다.
4. **다운로드** 버튼으로 변환된 파일을 받습니다.
5. iPhone에서는 **공유 → 사진에 저장**을 눌러 사진앱에 추가하세요.

## GitHub Pages 배포 방법

1. GitHub에서 새 리포지토리를 만들고 이 코드를 `main` 브랜치에 푸시합니다.

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<username>/<repo-name>.git
   git push -u origin main
   ```

2. 리포지토리 → **Settings** → **Pages**로 이동합니다.
3. **Source**를 **`GitHub Actions`** 로 선택합니다.
4. `main` 브랜치에 push가 일어나면 `.github/workflows/deploy.yml`이 자동 실행되어 Pages에 배포합니다.
5. Actions 탭에서 빌드 성공을 확인한 뒤 `https://<username>.github.io/<repo-name>/` 에서 앱을 사용할 수 있습니다.

> 참고: `.nojekyll` 파일은 Jekyll이 일부 파일을 누락하지 않도록 합니다. 삭제하지 마세요.

## 제한 사항

- **정지 이미지**: 최대 50MB
- **애니메이션**: 최대 20MB
- **브라우저**:
  - **정지 이미지**: WebP 디코딩이 가능한 모든 최신 브라우저 (Chrome / Safari 14+ / Firefox / Edge)
  - **애니메이션 → MP4**: **WebCodecs API**가 필요합니다. iOS 17 이상의 Safari, 또는 최신 Chrome / Edge에서 동작합니다. (Firefox는 현재 `VideoEncoder` 미지원으로 애니메이션 변환 불가)
- **네트워크**: 페이지 로드 시 [`mp4-muxer`](https://github.com/Vanilagy/mp4-muxer) (~10KB)만 CDN에서 받습니다. 변환 자체는 모두 브라우저 네이티브로 처리되며 추가 네트워크 사용이 없습니다.

## 작동 원리

| 단계 | 처리 |
|---|---|
| 판별 | RIFF/WebP 컨테이너의 `VP8X` 청크 플래그(0x02) 또는 `ANMF` 청크 존재 여부로 애니메이션 여부 결정 |
| 정지 이미지 | `createImageBitmap` → `OffscreenCanvas`/`<canvas>` → `toBlob('image/jpeg', 0.92)` |
| 애니메이션 | `ImageDecoder`로 프레임 추출 → `VideoEncoder`로 H.264 (Constrained Baseline 3.1, yuv420p) 인코딩 → `mp4-muxer`로 `+faststart` MP4 컨테이너 작성 |

## 라이선스

MIT.

`mp4-muxer`, `JSZip` 등 외부 라이브러리는 각 프로젝트의 라이선스를 따릅니다.
