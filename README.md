# WebP 변환기

WebP 파일을 iOS 사진앱에서 재생 가능한 형식(MP4 · JPEG)으로 변환하는 웹 앱입니다. 브라우저에서 모든 처리가 이루어지며 파일이 외부 서버로 전송되지 않습니다.

- **애니메이션 WebP → MP4** (H.264, iOS 호환)
- **정지 WebP → JPEG** (품질 0.92)
- 드래그 앤 드롭 · 다중 파일 일괄 처리 · ZIP 일괄 다운로드
- iOS Safari 우선 모바일 친화 UI

## 사용법

1. 페이지를 엽니다.
2. WebP 파일을 드롭존에 끌어다 놓거나 클릭해서 선택합니다.
3. 자동으로 애니메이션 / 정지 이미지를 판별해 변환합니다.
4. **다운로드** 버튼으로 변환된 파일을 받습니다.
5. iPhone에서는 **공유 → 사진에 저장**을 눌러 사진앱에 추가하세요.

## GitHub Pages 배포 방법

1. GitHub에서 새 리포지토리를 만듭니다 (예: `webp-converter`).
2. 이 코드를 `main` 브랜치에 푸시합니다.

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<username>/<repo-name>.git
   git push -u origin main
   ```

3. 리포지토리 → **Settings** → **Pages**로 이동합니다.
4. **Source**를 `Deploy from a branch`로 두고 **Branch**를 `main`, 폴더를 `/ (root)`로 선택한 뒤 **Save**합니다.
5. 약 1분 후 `https://<username>.github.io/<repo-name>/` 에서 앱을 사용할 수 있습니다.

> 참고: 리포지토리 루트의 `.nojekyll` 파일은 Jekyll이 일부 파일을 누락하지 않도록 합니다. 이 파일은 배포에 반드시 필요하니 삭제하지 마세요.

## 제한 사항

- **정지 이미지**: 최대 50MB
- **애니메이션**: 최대 20MB (모바일 메모리 한계 때문에 보수적으로 설정)
- **브라우저**: WebAssembly · Canvas · FileReader를 지원하는 최신 브라우저 (Chrome, Safari 15+, Firefox, Edge)
- **네트워크**: 첫 애니메이션 변환 시 변환 엔진(약 25MB)을 한 번만 내려받습니다. 이후에는 오프라인에서도 같은 세션 내에서 동작합니다.

## 작동 원리

| 단계 | 처리 |
|---|---|
| 판별 | RIFF/WebP 컨테이너의 `VP8X` 청크 플래그(0x02) 또는 `ANMF` 청크 존재 여부로 애니메이션 여부 결정 |
| 정지 이미지 | `createImageBitmap` → `OffscreenCanvas` (또는 `<canvas>`) → `convertToBlob('image/jpeg', 0.92)` |
| 애니메이션 | `ffmpeg.wasm` (단일 스레드) → `libx264` + `yuv420p` + `+faststart` + 짝수 크기 스케일 |

## 라이선스

MIT.

`@ffmpeg/ffmpeg`, `@ffmpeg/core`, `JSZip` 등 외부 라이브러리는 각 프로젝트의 라이선스를 따릅니다.
