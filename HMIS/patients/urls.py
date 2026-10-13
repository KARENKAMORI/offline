from rest_framework.routers import SimpleRouter
from .views import PatientViewSet, VisitViewSet

router = SimpleRouter()
# visits must be registered first so it isn't swallowed by the patient routes
router.register('visits', VisitViewSet, basename='visit')
router.register('', PatientViewSet, basename='patient')

urlpatterns = router.urls
